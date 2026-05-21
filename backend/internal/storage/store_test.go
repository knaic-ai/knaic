package storage

import (
	"errors"
	"testing"
)

func TestNewSeedsBuiltins(t *testing.T) {
	s := New("registry.knaic.local")
	got := s.List()
	if len(got) != 2 {
		t.Fatalf("List = %d targets, want 2 builtins", len(got))
	}
	for _, tgt := range got {
		if !tgt.Builtin {
			t.Fatalf("seed target %q expected to be builtin", tgt.Name)
		}
	}
}

func TestCreateAddsTarget(t *testing.T) {
	s := New("reg")
	t1, err := s.Create(CreateInput{Name: "team-s3", Kind: KindS3, Endpoint: "s3.example.com", Bucket: "team"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if t1.Builtin {
		t.Fatalf("user-created target must not be builtin")
	}
	if t1.ID == "" || t1.CreatedAt == "" {
		t.Fatalf("Create returned target missing id/createdAt: %#v", t1)
	}
	got, err := s.Get(t1.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "team-s3" {
		t.Fatalf("Get name = %q, want team-s3", got.Name)
	}
}

func TestCreateValidatesKind(t *testing.T) {
	s := New("reg")
	if _, err := s.Create(CreateInput{Name: "x", Kind: "bogus", Endpoint: "e"}); err == nil {
		t.Fatalf("expected error on unknown kind")
	}
	if _, err := s.Create(CreateInput{Name: "x", Kind: KindS3, Endpoint: ""}); err == nil {
		t.Fatalf("expected error on empty endpoint")
	}
	if _, err := s.Create(CreateInput{Name: "", Kind: KindS3, Endpoint: "e", Bucket: "b"}); err == nil {
		t.Fatalf("expected error on empty name")
	}
}

func TestCreateRejectsDuplicateName(t *testing.T) {
	s := New("reg")
	if _, err := s.Create(CreateInput{Name: "Built-in object store", Kind: KindS3, Endpoint: "e", Bucket: "b"}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("expected ErrAlreadyExists, got %v", err)
	}
}

func TestPatchAndDeleteRespectBuiltin(t *testing.T) {
	s := New("reg")
	builtins := s.List()
	id := builtins[0].ID
	if _, err := s.Patch(id, PatchInput{}); !errors.Is(err, ErrBuiltinLocked) {
		t.Fatalf("patch builtin: want ErrBuiltinLocked, got %v", err)
	}
	if err := s.Delete(id); !errors.Is(err, ErrBuiltinLocked) {
		t.Fatalf("delete builtin: want ErrBuiltinLocked, got %v", err)
	}
}

func TestPatchUpdatesUserTarget(t *testing.T) {
	s := New("reg")
	t1, _ := s.Create(CreateInput{Name: "team-s3", Kind: KindS3, Endpoint: "s3.example.com", Bucket: "team"})
	prefix := "v1/"
	updated, err := s.Patch(t1.ID, PatchInput{Prefix: &prefix})
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	if updated.Prefix != "v1/" {
		t.Fatalf("Prefix = %q, want v1/", updated.Prefix)
	}
}

func TestDeleteRemovesUserTarget(t *testing.T) {
	s := New("reg")
	t1, _ := s.Create(CreateInput{Name: "team-s3", Kind: KindS3, Endpoint: "s3.example.com", Bucket: "team"})
	if err := s.Delete(t1.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(t1.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete: want ErrNotFound, got %v", err)
	}
}
