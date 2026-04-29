package auth

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

type Verifier struct {
	v          *oidc.IDTokenVerifier
	adminGroup string
	disabled   bool
}

// New builds a verifier. If issuer is empty and disabled is true, returns a
// dev-mode verifier that injects a fake admin user.
func New(ctx context.Context, issuer, clientID, adminGroup string, disabled bool) (*Verifier, error) {
	if disabled {
		return &Verifier{adminGroup: adminGroup, disabled: true}, nil
	}
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc provider init: %w", err)
	}
	return &Verifier{
		v:          provider.Verifier(&oidc.Config{ClientID: clientID}),
		adminGroup: adminGroup,
	}, nil
}

type idClaims struct {
	Subject       string   `json:"sub"`
	Email         string   `json:"email"`
	Name          string   `json:"name"`
	PreferredName string   `json:"preferred_username"`
	Groups        []string `json:"groups"`
}

// Middleware returns an HTTP middleware that requires a valid bearer token and
// attaches the resolved User to the request context.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if v.disabled {
			u := &User{
				Subject:         "dev",
				Email:           "dev@knaic.local",
				Name:            "dev",
				Groups:          []string{v.adminGroup},
				IsPlatformAdmin: true,
			}
			next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), u)))
			return
		}
		raw := bearer(r)
		if raw == "" {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		tok, err := v.v.Verify(r.Context(), raw)
		if err != nil {
			http.Error(w, "invalid token: "+err.Error(), http.StatusUnauthorized)
			return
		}
		var c idClaims
		if err := tok.Claims(&c); err != nil {
			http.Error(w, "claim parse: "+err.Error(), http.StatusUnauthorized)
			return
		}
		name := c.Name
		if name == "" {
			name = c.PreferredName
		}
		if name == "" {
			name = c.Subject
		}
		u := &User{
			Subject:         c.Subject,
			Email:           c.Email,
			Name:            name,
			Groups:          c.Groups,
			IsPlatformAdmin: slices.Contains(c.Groups, v.adminGroup),
		}
		next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), u)))
	})
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	parts := strings.SplitN(h, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

// RequirePlatformAdmin gates a handler to platform admins.
func RequirePlatformAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := FromContext(r.Context())
		if !ok {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		if !u.IsPlatformAdmin {
			http.Error(w, "platform admin required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
