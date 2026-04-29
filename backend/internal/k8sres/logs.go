package k8sres

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"

	corev1 "k8s.io/api/core/v1"
)

// LogOptions are the query parameters accepted by the /pods/{name}/logs
// endpoint. Zero values fall through to the K8s defaults.
type LogOptions struct {
	Container    string
	Follow       bool
	TailLines    int64
	Previous     bool
	SinceSeconds int64
}

// StreamPodLogs writes a Server-Sent-Events stream of pod logs to w.
// Each line of pod stdout/stderr becomes one `data: ...\n\n` SSE frame.
//
// The handler keeps streaming until either the client disconnects (ctx
// canceled), the pod log API closes the stream, or follow=false returns
// the existing buffer in one pass.
func (s *Service) StreamPodLogs(ctx context.Context, w http.ResponseWriter, namespace, name string, opts LogOptions) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return fmt.Errorf("streaming unsupported (no http.Flusher)")
	}

	podOpts := &corev1.PodLogOptions{
		Container: opts.Container,
		Follow:    opts.Follow,
		Previous:  opts.Previous,
	}
	if opts.TailLines > 0 {
		t := opts.TailLines
		podOpts.TailLines = &t
	}
	if opts.SinceSeconds > 0 {
		s := opts.SinceSeconds
		podOpts.SinceSeconds = &s
	}

	req := s.typed.CoreV1().Pods(namespace).GetLogs(name, podOpts)
	rc, err := req.Stream(ctx)
	if err != nil {
		return err
	}
	defer rc.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	scanner := bufio.NewScanner(rc)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if _, err := fmt.Fprintf(w, "data: %s\n\n", sseEscape(line)); err != nil {
			return err
		}
		flusher.Flush()
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		return err
	}
	// Final event so the client can close cleanly.
	fmt.Fprintf(w, "event: end\ndata: \n\n")
	flusher.Flush()
	return nil
}

// sseEscape is conservative: callers must not embed bare `\n\n` in a single
// data frame because SSE uses that as the message terminator.
func sseEscape(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\r' {
			continue
		}
		if c == '\n' {
			// Multi-line strings — fold into a single SSE data line.
			out = append(out, ' ')
			continue
		}
		out = append(out, c)
	}
	return string(out)
}
