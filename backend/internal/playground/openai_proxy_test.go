package playground

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenAIProxyRewritesModelAndForwards(t *testing.T) {
	// Stand up a fake upstream that records the body it received.
	var received map[string]any
	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &received)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer upstream.Close()

	svc := NewServiceWithAgentStore(NewMemoryAgentStore(), &fakeAgentRunner{})
	p, err := svc.CreateProvider(context.Background(), ProviderRequest{
		Name:     "cluster-qwen",
		Endpoint: upstream.URL + "/v1",
		APIKey:   "sk-test",
		Model:    "qwen3-7b",
		Status:   StatusReady,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	proxy := NewOpenAIProxy(svc)
	body := map[string]any{
		"model":    p.ID + "/qwen3-7b",
		"messages": []map[string]any{{"role": "user", "content": "hi"}},
	}
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/openai/v1/chat/completions", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	proxy.ChatCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if received["model"] != "qwen3-7b" {
		t.Fatalf("upstream got model = %v, want %q (the upstream-only name, NOT the proxy composite)", received["model"], "qwen3-7b")
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("upstream got auth = %q, want %q", gotAuth, "Bearer sk-test")
	}
	if !strings.Contains(rec.Body.String(), `"content":"ok"`) {
		t.Fatalf("proxy body = %q, want passthrough of upstream", rec.Body.String())
	}
}

func TestOpenAIProxyRejectsUnknownProvider(t *testing.T) {
	svc := NewServiceWithAgentStore(NewMemoryAgentStore(), &fakeAgentRunner{})
	proxy := NewOpenAIProxy(svc)

	body, _ := json.Marshal(map[string]any{"model": "llm-999999/whatever"})
	req := httptest.NewRequest(http.MethodPost, "/openai/v1/chat/completions", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	proxy.ChatCompletions(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s; want 404 for unknown provider id", rec.Code, rec.Body.String())
	}
}

func TestSplitProxyModelRejectsMalformed(t *testing.T) {
	cases := []string{"", "no-slash", "/leading-slash", "trailing-slash/"}
	for _, in := range cases {
		if _, _, err := splitProxyModel(in); err == nil {
			t.Errorf("splitProxyModel(%q) = nil error, want error", in)
		}
	}
	pid, model, err := splitProxyModel("llm-1/qwen3-7b")
	if err != nil || pid != "llm-1" || model != "qwen3-7b" {
		t.Errorf("split happy path = (%q,%q,%v)", pid, model, err)
	}
}
