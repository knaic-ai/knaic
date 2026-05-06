package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
)

func TestImpersonateAppliesHeadersToTypedAndDynamicClients(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Impersonate-User"); got != "alice@example.com" {
			t.Fatalf("Impersonate-User = %q, want alice@example.com", got)
		}
		groups := r.Header.Values("Impersonate-Group")
		for _, want := range []string{"team-ml", "developers"} {
			if !slices.Contains(groups, want) {
				t.Fatalf("Impersonate-Group = %#v, missing %q", groups, want)
			}
		}
		paths = append(paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/namespaces":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"apiVersion": "v1",
				"kind":       "NamespaceList",
				"items":      []any{},
			})
		case "/apis/apps/v1/namespaces/team-ml/deployments":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"apiVersion": "apps/v1",
				"kind":       "DeploymentList",
				"items":      []any{},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	base := &Clients{Config: &rest.Config{Host: server.URL}}
	userClients, err := base.Impersonate("alice@example.com", []string{"team-ml", "developers"})
	if err != nil {
		t.Fatalf("impersonate: %v", err)
	}
	if _, err := userClients.Typed.CoreV1().Namespaces().List(context.Background(), metav1.ListOptions{}); err != nil {
		t.Fatalf("typed list: %v", err)
	}
	gvr := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	if _, err := userClients.Dynamic.Resource(gvr).Namespace("team-ml").List(context.Background(), metav1.ListOptions{}); err != nil {
		t.Fatalf("dynamic list: %v", err)
	}
	for _, want := range []string{"/api/v1/namespaces", "/apis/apps/v1/namespaces/team-ml/deployments"} {
		if !slices.Contains(paths, want) {
			t.Fatalf("paths = %#v, missing %q", paths, want)
		}
	}
}
