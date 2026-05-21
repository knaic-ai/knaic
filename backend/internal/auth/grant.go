package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Grant cookies are the answer to a specific gap: `<iframe src=...>` requests
// don't carry the `Authorization` bearer header, only cookies. The OIDC
// verifier therefore can't authenticate the per-PVC viewer proxy that's
// embedded in an iframe.
//
// A grant cookie is a per-user, per-path, time-limited HMAC-signed blob
// that authorises *one specific URL prefix* (typically the per-PVC viewer
// reverse proxy). The user obtains it by hitting a `/grant`-style
// endpoint with a normal bearer token. We then set it as an HttpOnly
// cookie scoped to that prefix. Subsequent in-iframe requests carry the
// cookie automatically.
//
// Threat model:
//   - HMAC signature with a per-process random secret prevents forgery.
//   - 10-minute default expiry caps replay value.
//   - Cookie Path scoping means the browser only sends the grant to the
//     specific viewer URL; nothing else on the API sees it.
//   - The grant carries the *user identity* (subject, email, groups) so
//     the verifier middleware can build the same User context it would
//     have built from a bearer — every downstream handler (including the
//     apiserver-impersonation client) behaves the same as on the bearer
//     path.
//   - Grant tokens are NOT a substitute for bearer auth on JSON
//     endpoints; they are accepted only when the request path matches
//     the granted scope. A grant scoped to /api/v1/.../pvc/foo/viewer/
//     can't be used to call /api/v1/.../pvc/bar/viewer/start, even by
//     copy-pasting the cookie.

// GrantStore mints and verifies HMAC-signed scope-bound grants.
//
// Stateless: the HMAC secret lives in process memory and is regenerated
// per process. That means grants don't survive a knaic-api restart, which
// is fine for ten-minute viewer sessions — the frontend just re-grants.
type GrantStore struct {
	secret []byte
	now    func() time.Time
}

// NewGrantStore returns a store seeded with a fresh random secret.
func NewGrantStore() (*GrantStore, error) {
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, fmt.Errorf("grant: read random secret: %w", err)
	}
	return &GrantStore{secret: secret[:], now: func() time.Time { return time.Now().UTC() }}, nil
}

// grantPayload is the JSON body of a grant. We mirror the User shape so
// the verifier can hand the same object downstream regardless of which
// auth path was taken.
type grantPayload struct {
	Subject string   `json:"sub"`
	Email   string   `json:"email,omitempty"`
	Name    string   `json:"name,omitempty"`
	Groups  []string `json:"groups,omitempty"`
	IsAdmin bool     `json:"isAdmin,omitempty"`
	// Scope is a URL path prefix. The grant is valid for any request
	// whose path starts with this string. Use a trailing slash to limit
	// to "things below this folder".
	Scope string `json:"scope"`
	// ExpUnix is seconds since epoch — small wire form vs RFC3339.
	ExpUnix int64 `json:"exp"`
}

// Mint creates a signed grant token for the given user, scoped to the
// given URL prefix and valid for ttl. The returned token is
// "v1.<base64-payload>.<base64-mac>" and is safe to put in a cookie.
func (g *GrantStore) Mint(u *User, scope string, ttl time.Duration) (string, time.Time, error) {
	if u == nil {
		return "", time.Time{}, errors.New("grant: user is required")
	}
	if scope == "" {
		return "", time.Time{}, errors.New("grant: scope is required")
	}
	exp := g.now().Add(ttl)
	body := grantPayload{
		Subject: u.Subject,
		Email:   u.Email,
		Name:    u.Name,
		Groups:  u.Groups,
		IsAdmin: u.IsPlatformAdmin,
		Scope:   scope,
		ExpUnix: exp.Unix(),
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", time.Time{}, err
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := g.sign(payload)
	return "v1." + payload + "." + mac, exp, nil
}

// Verify checks the token's signature and expiry, then returns the
// decoded user. If scopeReq is non-empty, also confirms the token's
// scope covers it (token.scope is a prefix of scopeReq).
func (g *GrantStore) Verify(token, scopeReq string) (*User, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return nil, errors.New("grant: bad token shape")
	}
	payload, mac := parts[1], parts[2]
	want := g.sign(payload)
	// Constant-time compare so signature checks don't leak timing info.
	if subtle.ConstantTimeCompare([]byte(mac), []byte(want)) != 1 {
		return nil, errors.New("grant: signature mismatch")
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("grant: payload decode: %w", err)
	}
	var p grantPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("grant: payload parse: %w", err)
	}
	if time.Unix(p.ExpUnix, 0).Before(g.now()) {
		return nil, errors.New("grant: expired")
	}
	if scopeReq != "" && !strings.HasPrefix(scopeReq, p.Scope) {
		return nil, errors.New("grant: scope mismatch")
	}
	return &User{
		Subject:         p.Subject,
		Email:           p.Email,
		Name:            p.Name,
		Groups:          p.Groups,
		IsPlatformAdmin: p.IsAdmin,
	}, nil
}

func (g *GrantStore) sign(payload string) string {
	h := hmac.New(sha256.New, g.secret)
	_, _ = h.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// GrantCookieName is the name of the cookie we set + read. Exposed so
// handlers can set Path scopes consistently.
const GrantCookieName = "knaic_grant"

// GrantFromRequest reads the grant cookie (if present) and verifies it
// against the current request path. Returns nil, nil if no cookie is
// present so callers can fall back to bearer-auth without distinguishing
// "no cookie" from "bad cookie" in the same branch.
func (g *GrantStore) FromRequest(r *http.Request) (*User, error) {
	c, err := r.Cookie(GrantCookieName)
	if err != nil {
		return nil, nil //nolint:nilnil // by design — see doc above
	}
	return g.Verify(c.Value, r.URL.Path)
}
