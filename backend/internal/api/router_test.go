package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alauda/knaic-backend/internal/auth"
)

func TestWhoamiUsesLowerCamelJSONFields(t *testing.T) {
	verifier, err := auth.New(context.Background(), "", "knaic", "knaic:platform-admins", true, true)
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/whoami", nil)
	rec := httptest.NewRecorder()

	NewRouter(Deps{Verifier: verifier}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	for _, key := range []string{"subject", "email", "name", "groups", "isPlatformAdmin"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("response missing %q: %#v", key, got)
		}
	}
	if _, ok := got["Subject"]; ok {
		t.Fatalf("response includes Go field name Subject: %#v", got)
	}
}

func TestWhoamiRequiresBearerWhenAuthEnabled(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/whoami", nil)
	rec := httptest.NewRecorder()

	NewRouter(Deps{Verifier: &auth.Verifier{}}).ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
}

func TestAuthConfigIsPublicAndContainsOnlyOIDCLoginFields(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/config", nil)
	rec := httptest.NewRecorder()

	NewRouter(Deps{
		AuthConfig: AuthConfig{
			Issuer:   "https://dex.example.com",
			ClientID: "knaic",
			Scopes:   "openid profile email groups",
		},
	}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	want := map[string]string{
		"issuer":   "https://dex.example.com",
		"clientId": "knaic",
		"scopes":   "openid profile email groups",
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("%s = %#v, want %q", key, got[key], value)
		}
	}
	if _, ok := got["authDisabled"]; ok {
		t.Fatalf("auth config exposed authDisabled: %#v", got)
	}
}
