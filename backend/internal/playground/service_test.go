package playground

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProviderListRedactsAPIKeys(t *testing.T) {
	svc := NewService()
	created, err := svc.CreateProvider(context.Background(), ProviderRequest{
		Name:        "external-openai",
		Source:      SourceExternal,
		Endpoint:    "https://api.openai.example/v1",
		APIKey:      "sk-secret",
		Model:       "gpt-4o",
		Description: "external provider",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	listed := svc.ListProviders(context.Background(), "")
	if len(listed) != 1 {
		t.Fatalf("len(listed) = %d, want 1", len(listed))
	}
	if listed[0].ID != created.ID {
		t.Fatalf("listed id = %q, want %q", listed[0].ID, created.ID)
	}
	if listed[0].APIKey != "" {
		t.Fatalf("listed API key should be redacted, got %q", listed[0].APIKey)
	}
}

func TestChatUsesOpenAICompatibleEndpoint(t *testing.T) {
	var gotAuth string
	var gotModel string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		gotModel = body.Model
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"pong"}}]}`))
	}))
	defer server.Close()

	svc := NewService()
	provider, err := svc.CreateProvider(context.Background(), ProviderRequest{
		Name:     "cluster-qwen",
		Source:   SourceCluster,
		Endpoint: server.URL + "/v1",
		APIKey:   "test-token",
		Model:    "qwen",
		Status:   StatusReady,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	resp, err := svc.Chat(context.Background(), ChatRequest{
		ProviderID: provider.ID,
		Messages: []Message{{
			Role:    "user",
			Content: "ping",
		}},
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if gotAuth != "Bearer test-token" {
		t.Fatalf("auth = %q, want bearer token", gotAuth)
	}
	if gotModel != "qwen" {
		t.Fatalf("model = %q, want qwen", gotModel)
	}
	if resp.Message.Content != "pong" {
		t.Fatalf("content = %q, want pong", resp.Message.Content)
	}
}

func TestStreamChatProxiesOpenAICompatibleEvents(t *testing.T) {
	var gotStream bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream bool `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		gotStream = body.Stream
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"po\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"ng\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	svc := NewService()
	provider, err := svc.CreateProvider(context.Background(), ProviderRequest{
		Name:     "cluster-qwen",
		Source:   SourceCluster,
		Endpoint: server.URL + "/v1",
		Model:    "qwen",
		Status:   StatusReady,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	stream, err := svc.StreamChat(context.Background(), ChatRequest{
		ProviderID: provider.ID,
		Messages: []Message{{
			Role:    "user",
			Content: "ping",
		}},
	})
	if err != nil {
		t.Fatalf("stream chat: %v", err)
	}
	defer stream.Body.Close()
	raw, err := io.ReadAll(stream.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	if !gotStream {
		t.Fatal("provider request did not set stream=true")
	}
	if stream.ContentType != "text/event-stream" {
		t.Fatalf("content type = %q", stream.ContentType)
	}
	if !strings.Contains(string(raw), "data: [DONE]") {
		t.Fatalf("stream did not include completion event: %s", raw)
	}
}
