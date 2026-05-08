package k8sres

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
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

// InferenceLogTarget is the pod chosen for an InferenceService-style log
// request. The backend resolves this so the UI does not need to understand
// KServe's controller-created pod names.
type InferenceLogTarget struct {
	Namespace  string
	PodName    string
	Containers []string
}

// InferencePodInfo describes one pod backing an InferenceService for the
// log viewer's pod picker. During a rolling update there are multiple pods
// (old ReplicaSet + new ReplicaSet); the picker lets the user inspect each.
type InferencePodInfo struct {
	Name           string   `json:"name"`
	Phase          string   `json:"phase"`
	Ready          bool     `json:"ready"`
	Containers     []string `json:"containers"`
	InitContainers []string `json:"initContainers,omitempty"`
	CreatedAt      string   `json:"createdAt,omitempty"`
}

// ResolveInferenceLogTarget picks the best matching pod for an
// InferenceService or LLMInferenceService. It prefers standard KServe labels,
// then common app/owner/name fallbacks for installs with different labels.
func (s *Service) ResolveInferenceLogTarget(ctx context.Context, namespace, name, kind string) (InferenceLogTarget, error) {
	if s.typed == nil {
		return InferenceLogTarget{}, fmt.Errorf("typed Kubernetes client not initialized")
	}
	list, err := s.typed.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return InferenceLogTarget{}, err
	}

	type candidate struct {
		pod   corev1.Pod
		score int
	}
	var candidates []candidate
	for _, pod := range list.Items {
		score := inferencePodScore(&pod, name, kind)
		if score <= 0 {
			continue
		}
		candidates = append(candidates, candidate{pod: pod, score: score})
	}
	if len(candidates) == 0 {
		return InferenceLogTarget{}, apierrors.NewNotFound(
			schema.GroupResource{Resource: "pods"},
			fmt.Sprintf("for inference service %s/%s", namespace, name),
		)
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.score != b.score {
			return a.score > b.score
		}
		if podReady(&a.pod) != podReady(&b.pod) {
			return podReady(&a.pod)
		}
		if (a.pod.Status.Phase == corev1.PodRunning) != (b.pod.Status.Phase == corev1.PodRunning) {
			return a.pod.Status.Phase == corev1.PodRunning
		}
		if !a.pod.CreationTimestamp.Equal(&b.pod.CreationTimestamp) {
			return a.pod.CreationTimestamp.After(b.pod.CreationTimestamp.Time)
		}
		return a.pod.Name < b.pod.Name
	})

	pod := candidates[0].pod
	return InferenceLogTarget{
		Namespace:  namespace,
		PodName:    pod.Name,
		Containers: podContainerNames(&pod),
	}, nil
}

// StreamInferenceServiceLogs resolves the controller-created serving pod and
// streams that pod's logs using the normal Kubernetes pods/log API.
func (s *Service) StreamInferenceServiceLogs(ctx context.Context, w http.ResponseWriter, namespace, name, kind string, opts LogOptions) error {
	target, err := s.ResolveInferenceLogTarget(ctx, namespace, name, kind)
	if err != nil {
		return err
	}
	if opts.Container == "" {
		opts.Container = preferredInferenceContainer(target.Containers)
	}
	return s.StreamPodLogs(ctx, w, target.Namespace, target.PodName, opts)
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

func inferencePodScore(pod *corev1.Pod, name, kind string) int {
	labels := pod.GetLabels()
	score := 0
	bump := func(v int) {
		if v > score {
			score = v
		}
	}

	if kind == "LLMInferenceService" {
		if labels["serving.kserve.io/llminferenceservice"] == name {
			bump(120)
		}
		if labels["kserve.io/llminferenceservice"] == name {
			bump(115)
		}
	}
	if kind == "InferenceService" || kind == "" {
		if labels["serving.kserve.io/inferenceservice"] == name {
			bump(120)
		}
		if labels["kserve.io/inferenceservice"] == name {
			bump(115)
		}
	}

	// Accept both label families as fallbacks even when the caller passes the
	// wrong kind; the service name still scopes the lookup to this namespace.
	if labels["serving.kserve.io/inferenceservice"] == name || labels["serving.kserve.io/llminferenceservice"] == name {
		bump(100)
	}
	if labels["app.kubernetes.io/instance"] == name || labels["app.kubernetes.io/name"] == name {
		bump(80)
	}
	if labels["app"] == name {
		bump(70)
	}
	for _, owner := range pod.OwnerReferences {
		if owner.Name == name || strings.HasPrefix(owner.Name, name+"-") {
			bump(55)
		}
	}
	if pod.Name == name || strings.HasPrefix(pod.Name, name+"-") {
		bump(45)
	}

	if score == 0 {
		return 0
	}
	if labels["serving.kserve.io/component"] == "predictor" || labels["component"] == "predictor" {
		score += 10
	}
	if pod.Status.Phase == corev1.PodRunning {
		score += 20
	}
	if podReady(pod) {
		score += 30
	}
	return score
}

func podReady(pod *corev1.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

func podContainerNames(pod *corev1.Pod) []string {
	names := make([]string, 0, len(pod.Spec.Containers))
	for _, c := range pod.Spec.Containers {
		if c.Name != "" {
			names = append(names, c.Name)
		}
	}
	return names
}

func podInitContainerNames(pod *corev1.Pod) []string {
	names := make([]string, 0, len(pod.Spec.InitContainers))
	for _, c := range pod.Spec.InitContainers {
		if c.Name != "" {
			names = append(names, c.Name)
		}
	}
	return names
}

// ListInferencePods returns every pod that the resolver considers a match
// for the given InferenceService / LLMInferenceService — sorted newest-first
// so the freshly-rolled ReplicaSet's pod is on top during a rollout. The log
// viewer uses this to let users switch between pods (and inspect old ones
// before the controller GCs them).
func (s *Service) ListInferencePods(ctx context.Context, namespace, name, kind string) ([]InferencePodInfo, error) {
	if s.typed == nil {
		return nil, fmt.Errorf("typed Kubernetes client not initialized")
	}
	list, err := s.typed.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	type scored struct {
		pod   corev1.Pod
		score int
	}
	var hits []scored
	for _, pod := range list.Items {
		score := inferencePodScore(&pod, name, kind)
		if score <= 0 {
			continue
		}
		hits = append(hits, scored{pod: pod, score: score})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		// Highest match score first, then ready pods, then newest, then name.
		if a.score != b.score {
			return a.score > b.score
		}
		if podReady(&a.pod) != podReady(&b.pod) {
			return podReady(&a.pod)
		}
		if !a.pod.CreationTimestamp.Equal(&b.pod.CreationTimestamp) {
			return a.pod.CreationTimestamp.After(b.pod.CreationTimestamp.Time)
		}
		return a.pod.Name < b.pod.Name
	})
	out := make([]InferencePodInfo, 0, len(hits))
	for _, h := range hits {
		out = append(out, InferencePodInfo{
			Name:           h.pod.Name,
			Phase:          string(h.pod.Status.Phase),
			Ready:          podReady(&h.pod),
			Containers:     podContainerNames(&h.pod),
			InitContainers: podInitContainerNames(&h.pod),
			CreatedAt:      h.pod.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	return out, nil
}

func preferredInferenceContainer(containers []string) string {
	for _, preferred := range []string{"kserve-container", "main", "model-server", "worker"} {
		for _, c := range containers {
			if c == preferred {
				return c
			}
		}
	}
	for _, c := range containers {
		switch c {
		case "queue-proxy", "istio-proxy", "storage-initializer":
			continue
		default:
			return c
		}
	}
	if len(containers) > 0 {
		return containers[0]
	}
	return ""
}
