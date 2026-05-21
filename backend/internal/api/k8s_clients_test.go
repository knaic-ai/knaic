package api

import (
	"net/http/httptest"
	"testing"

	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/k8s"
)

func TestK8sClientSourceUsesBaseClientsWhenAuthDisabled(t *testing.T) {
	typed := fake.NewSimpleClientset()
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	source := k8sClientSource{
		base:         &k8s.Clients{Typed: typed, Dynamic: dyn},
		authDisabled: true,
	}
	req := httptest.NewRequest("GET", "/api/v1/namespaces/default/pods", nil)
	req = req.WithContext(auth.WithUser(req.Context(), &auth.User{
		Subject:         "dev",
		Email:           "dev@knaic.local",
		Name:            "dev",
		IsPlatformAdmin: true,
	}))

	clients, err := source.clientsForRequest(req)
	if err != nil {
		t.Fatalf("clientsForRequest: %v", err)
	}
	if clients.Typed != typed {
		t.Fatalf("typed client was not the base client")
	}
	if clients.Dynamic != dyn {
		t.Fatalf("dynamic client was not the base client")
	}
}

func TestK8sClientSourceRequiresImpersonationIdentityWhenAuthEnabled(t *testing.T) {
	source := k8sClientSource{
		base:      &k8s.Clients{},
		userClaim: "email",
	}
	req := httptest.NewRequest("GET", "/api/v1/namespaces/default/pods", nil)
	req = req.WithContext(auth.WithUser(req.Context(), &auth.User{Subject: "alice"}))

	if _, err := source.clientsForRequest(req); err == nil {
		t.Fatalf("clientsForRequest returned nil error without an impersonation identity")
	}
}
