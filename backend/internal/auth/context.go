package auth

import "context"

type User struct {
	Subject         string   `json:"subject"`
	Email           string   `json:"email"`
	Name            string   `json:"name"`
	Groups          []string `json:"groups"`
	IsPlatformAdmin bool     `json:"isPlatformAdmin"`
}

type ctxKey struct{}
type bearerCtxKey struct{}

func WithUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, ctxKey{}, u)
}

func FromContext(ctx context.Context) (*User, bool) {
	u, ok := ctx.Value(ctxKey{}).(*User)
	return u, ok
}

// MustFromContext panics if no user — only call inside handlers gated by Middleware.
func MustFromContext(ctx context.Context) *User {
	u, ok := FromContext(ctx)
	if !ok {
		panic("auth: no user in context")
	}
	return u
}

// WithBearer stashes the raw, verified bearer token so downstream services
// (e.g. the monitoring proxy) can forward it on upstream calls — useful when
// the upstream sits behind an oauth2-proxy that shares the same OIDC issuer.
func WithBearer(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, bearerCtxKey{}, token)
}

// BearerFromContext returns the verified bearer token captured by the auth
// middleware. Empty string when auth is disabled or the request didn't carry
// a token.
func BearerFromContext(ctx context.Context) string {
	v, _ := ctx.Value(bearerCtxKey{}).(string)
	return v
}
