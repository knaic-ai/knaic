package models

import (
	"context"
	"errors"
	"testing"
	"time"

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

func TestParseSchemeAcceptsHFMirrorURIAsHuggingFace(t *testing.T) {
	scheme, err := ParseScheme("hf-mirror://Qwen/Qwen3.5-7B-Instruct")
	if err != nil {
		t.Fatalf("ParseScheme: %v", err)
	}
	if scheme != SchemeHF {
		t.Fatalf("scheme = %q, want %q", scheme, SchemeHF)
	}
}

func TestMemoryStoreListsByCreationTimeNewestFirst(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	oldCreated := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	newCreated := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	oldUpdated := time.Date(2026, 5, 3, 10, 0, 0, 0, time.UTC)

	if _, err := store.Create(ctx, Model{
		ID:        "old",
		Name:      "old",
		Scope:     ScopePublic,
		URI:       "hf://old",
		Scheme:    SchemeHF,
		CreatedAt: oldCreated,
		UpdatedAt: oldUpdated,
	}); err != nil {
		t.Fatalf("create old: %v", err)
	}
	if _, err := store.Create(ctx, Model{
		ID:        "new",
		Name:      "new",
		Scope:     ScopePublic,
		URI:       "hf://new",
		Scheme:    SchemeHF,
		CreatedAt: newCreated,
		UpdatedAt: newCreated,
	}); err != nil {
		t.Fatalf("create new: %v", err)
	}

	got, err := store.List(ctx, ScopePublic, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].ID != "new" || got[1].ID != "old" {
		t.Fatalf("order = %s, %s; want new, old", got[0].ID, got[1].ID)
	}
}
