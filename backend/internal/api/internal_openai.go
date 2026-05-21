package api

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/playground"
)

// mountInternalOpenAI exposes the OpenAI-compatible proxy the opencode sidecar
// dials. It lives OUTSIDE the OIDC-gated /api/v1 group because the sidecar
// has no Dex bearer; instead we share a per-process random token with the
// sidecar via the shared volume, and only requests presenting it succeed.
//
// We don't trust RemoteAddr / X-Forwarded-For for gating because chimw.RealIP
// is applied globally and would let any external caller spoof 127.0.0.1.
// A constant-time secret compare avoids that whole class of bug.
func mountInternalOpenAI(r chi.Router, svc *playground.Service, token string) {
	if svc == nil || token == "" {
		return
	}
	proxy := playground.NewOpenAIProxy(svc)
	r.Route("/internal/openai/v1", func(r chi.Router) {
		r.Use(requireInternalToken(token))
		r.Get("/models", proxy.Models)
		r.Post("/chat/completions", proxy.ChatCompletions)
	})
}

func requireInternalToken(token string) func(http.Handler) http.Handler {
	want := []byte(token)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(got), want) != 1 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
