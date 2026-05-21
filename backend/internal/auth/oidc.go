package auth

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

type Verifier struct {
	v             *oidc.IDTokenVerifier
	adminGroup    string
	client        *http.Client
	disabled      bool
	adminResolver *AdminResolver
	// grants is an optional fallback auth path for requests that can't
	// carry an Authorization header — specifically the in-iframe viewer
	// proxy used by the AI Storage PVC manager. nil means "bearer only".
	grants *GrantStore
}

// SetGrantStore wires a grant cookie fallback into the verifier.
// Attached post-construction so the same store can be shared with
// handlers that mint grants (no circular import).
func (v *Verifier) SetGrantStore(g *GrantStore) {
	if v == nil {
		return
	}
	v.grants = g
}

// SetAdminResolver wires an apiserver-backed CRB resolver. Attached after
// construction because the k8s client isn't built yet when auth.New runs.
// Passing nil is a no-op; the verifier falls back to group-claim-only
// admin detection.
func (v *Verifier) SetAdminResolver(r *AdminResolver) {
	if v == nil {
		return
	}
	v.adminResolver = r
}

// New builds a verifier. If issuer is empty and disabled is true, returns a
// dev-mode verifier that injects a fake admin user.
func New(
	ctx context.Context,
	issuer, clientID, adminGroup string,
	insecureSkipVerify, disabled bool,
) (*Verifier, error) {
	if disabled {
		return &Verifier{adminGroup: adminGroup, disabled: true}, nil
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: insecureSkipVerify}
	client := &http.Client{Transport: transport}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, client), issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc provider init: %w", err)
	}
	return &Verifier{
		v:          provider.Verifier(&oidc.Config{ClientID: clientID}),
		adminGroup: adminGroup,
		client:     client,
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
			// Fallback: grant cookies. Used by the per-PVC viewer
			// iframe (and any other in-browser embed that can't set
			// Authorization). The grant carries its own scope check,
			// so a cookie minted for /aistorage/pvc/foo/viewer/ can't
			// authenticate /api/v1/whoami.
			if v.grants != nil {
				u, err := v.grants.FromRequest(r)
				if err == nil && u != nil {
					next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), u)))
					return
				}
			}
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		verifyCtx := oidc.ClientContext(r.Context(), v.client)
		tok, err := v.v.Verify(verifyCtx, raw)
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
		// Group claim is the fast path; CRB lookup is the additive one for
		// users bound to cluster-admin as a User subject rather than via a
		// group.
		if !u.IsPlatformAdmin && v.adminResolver != nil {
			if v.adminResolver.IsAdmin(r.Context(), u) {
				u.IsPlatformAdmin = true
			}
		}
		ctx := WithUser(r.Context(), u)
		ctx = WithBearer(ctx, raw)
		next.ServeHTTP(w, r.WithContext(ctx))
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
