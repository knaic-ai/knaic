package playground

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// OpenAIProxy serves an OpenAI-compatible surface so the opencode sidecar can
// talk to all configured providers through a single, stable URL. opencode
// requires every model id to be pre-declared in its static config and does
// not hot-reload, so we keep ONE provider ("knaic") in opencode's config and
// rotate the actual upstream by parsing the model id of every chat request:
//
//	model = "<knaic-provider-id>/<upstream-model-name>"
//	     e.g. "llm-000042/qwen3-7b"
//
// The proxy looks up the knaic provider by id, rewrites body.model to the
// upstream-model-name, then forwards the request unchanged (preserving
// streaming, temperature, tools, etc.). This way:
//   - opencode's config can be regenerated whenever knaic's provider set
//     changes (only the embedded model catalog moves), but the URL and the
//     provider id ("knaic") stay constant.
//   - multi-tenancy is enforced at the knaic Provider id, which is globally
//     unique across namespaces — no cross-tenant collision even when two
//     teams deploy a model with the same name.
type OpenAIProxy struct {
	svc *Service
}

func NewOpenAIProxy(svc *Service) *OpenAIProxy {
	return &OpenAIProxy{svc: svc}
}

func (p *OpenAIProxy) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeProxyError(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		writeProxyError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	rawModel, _ := body["model"].(string)
	providerID, upstreamModel, err := splitProxyModel(rawModel)
	if err != nil {
		writeProxyError(w, http.StatusBadRequest, err.Error())
		return
	}
	provider, client, err := p.svc.providerForChat(providerID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeProxyError(w, http.StatusNotFound, "unknown knaic provider id: "+providerID)
			return
		}
		writeProxyError(w, http.StatusBadRequest, err.Error())
		return
	}
	body["model"] = upstreamModel
	stream, _ := body["stream"].(bool)
	rewritten, err := json.Marshal(body)
	if err != nil {
		writeProxyError(w, http.StatusInternalServerError, "rewrite body: "+err.Error())
		return
	}
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, provider.Endpoint+"/chat/completions", bytes.NewReader(rewritten))
	if err != nil {
		writeProxyError(w, http.StatusInternalServerError, "build upstream request: "+err.Error())
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	if stream {
		upReq.Header.Set("Accept", "text/event-stream")
	}
	if provider.APIKey != "" {
		upReq.Header.Set("Authorization", "Bearer "+provider.APIKey)
	}
	res, err := client.Do(upReq)
	if err != nil {
		writeProxyError(w, http.StatusBadGateway, "upstream: "+err.Error())
		return
	}
	defer res.Body.Close()

	for k, vs := range res.Header {
		// hop-by-hop headers stripped; chi adds its own.
		if strings.EqualFold(k, "Content-Length") || strings.EqualFold(k, "Connection") {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(res.StatusCode)
	flusher, _ := w.(http.Flusher)
	if stream && flusher != nil {
		copyStream(w, res.Body, flusher)
	} else {
		_, _ = io.Copy(w, res.Body)
	}
}

func (p *OpenAIProxy) Models(w http.ResponseWriter, _ *http.Request) {
	// Return the model catalog opencode is configured against so a curl-style
	// /v1/models smoke check works. opencode itself does not call this — its
	// model list comes from its static config — so the catalog only needs to
	// be loosely accurate.
	w.Header().Set("Content-Type", "application/json")
	providers := p.svc.snapshotProviders()
	type model struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	data := make([]model, 0, len(providers))
	for _, pr := range providers {
		data = append(data, model{
			ID:      pr.ID + "/" + pr.Model,
			Object:  "model",
			OwnedBy: pr.Name,
		})
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
}

// splitProxyModel parses "<knaic-provider-id>/<upstream-model>" into its
// parts. We require both halves so a misconfigured opencode catalog produces
// a clear 400 instead of a confusing upstream 404.
func splitProxyModel(s string) (providerID, upstreamModel string, err error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", "", errors.New("model is required in request body")
	}
	idx := strings.Index(s, "/")
	if idx <= 0 || idx == len(s)-1 {
		return "", "", fmt.Errorf("model must be of the form '<knaic-provider-id>/<upstream-model>', got %q", s)
	}
	return s[:idx], s[idx+1:], nil
}

func writeProxyError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": msg,
			"type":    "knaic_proxy_error",
		},
	})
}

func copyStream(dst io.Writer, src io.Reader, flusher http.Flusher) {
	buf := make([]byte, 4096)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
			flusher.Flush()
		}
		if err != nil {
			return
		}
	}
}

// snapshotProviders is consumed by both the proxy and the opencode-server
// runner; keep it lock-correct.
func (s *Service) snapshotProviders() []Provider {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Provider, 0, len(s.providers))
	for _, p := range s.providers {
		out = append(out, p)
	}
	return out
}

