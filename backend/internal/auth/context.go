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
