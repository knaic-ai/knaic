package playground

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMCPK8sListUsesBackendAuthAndSelectedNamespace(t *testing.T) {
	var gotPath string
	var gotAuth string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`[{"name":"pod-a"}]`))
	}))
	defer ts.Close()

	server := &MCPServer{
		baseURL:   ts.URL,
		token:     "Bearer user-token",
		namespace: "team-ml",
		client:    ts.Client(),
	}
	text, err := server.callTool(context.Background(), "k8s_list", map[string]any{"resource": "pods"})
	if err != nil {
		t.Fatalf("callTool: %v", err)
	}
	if text != `[{"name":"pod-a"}]` {
		t.Fatalf("text = %q", text)
	}
	if gotPath != "/api/v1/namespaces/team-ml/pods" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer user-token" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
}

func TestMCPDoesNotExposeSecretsToAgent(t *testing.T) {
	server := &MCPServer{baseURL: "http://127.0.0.1:1"}
	if _, err := server.callTool(context.Background(), "k8s_yaml", map[string]any{
		"resource": "secrets",
		"name":     "db-password",
	}); err == nil {
		t.Fatalf("secrets should not be available to the agent")
	}
}
