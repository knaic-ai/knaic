package models

import (
	"context"
	"errors"
	"testing"

	"github.com/alauda/knaic-backend/internal/auth"
)

func TestPrivateModelWriteRequiresNamespaceAuthorizationForNonAdmin(t *testing.T) {
	svc := NewService(NewMemoryStore())
	_, err := svc.Create(context.Background(), &auth.User{
		Subject: "alice",
		Email:   "alice@example.com",
		Name:    "Alice",
	}, CreateRequest{
		Name:      "team model",
		URI:       "hf://team/model",
		Scope:     ScopePrivate,
		Namespace: "team-ml",
	})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestPlatformAdminPrivateModelWriteStillWorksWithoutAuthorizer(t *testing.T) {
	svc := NewService(NewMemoryStore())
	_, err := svc.Create(context.Background(), &auth.User{
		Subject:         "dev",
		Email:           "dev@knaic.local",
		Name:            "dev",
		IsPlatformAdmin: true,
	}, CreateRequest{
		Name:      "team model",
		URI:       "hf://team/model",
		Scope:     ScopePrivate,
		Namespace: "team-ml",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
}
