// Package storage owns the registry of object/blob storage targets that the
// Model Hub UI uses to upload, import, and reference model artifacts. Each
// Target is an addressable destination: an S3 bucket, an OCI registry path,
// or a Kubernetes PVC. Built-in targets are seeded at startup and protected
// from deletion; users with platform-admin can register additional ones.
//
// This package is intentionally in-memory. State resets on restart, which is
// acceptable for the current Model Hub UX (the targets only describe where
// model files live; the model metadata itself is stored separately and is
// either Postgres-backed or seeded on boot). When persistence is needed,
// swap the Store implementation for a ConfigMap-backed one — same pattern
// as the registry package today.
package storage

import (
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Kind enumerates the supported target backends. The frontend uses the same
// strings as discriminators on the union type.
type Kind string

const (
	KindS3  Kind = "s3"
	KindOCI Kind = "oci"
	KindPVC Kind = "pvc"
)

// Target is one storage destination as the Model Hub sees it.
type Target struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      Kind   `json:"kind"`
	Endpoint  string `json:"endpoint"`
	Bucket    string `json:"bucket,omitempty"`
	Prefix    string `json:"prefix,omitempty"`
	Builtin   bool   `json:"builtin"`
	CreatedAt string `json:"createdAt,omitempty"`
}

// CreateInput is the request body accepted by Create. The backend assigns
// id, builtin=false, and createdAt; the rest comes from the user.
type CreateInput struct {
	Name     string `json:"name"`
	Kind     Kind   `json:"kind"`
	Endpoint string `json:"endpoint"`
	Bucket   string `json:"bucket,omitempty"`
	Prefix   string `json:"prefix,omitempty"`
}

// PatchInput is the request body for Patch — pointer fields so callers can
// update individual properties without having to re-send the whole target.
type PatchInput struct {
	Name     *string `json:"name,omitempty"`
	Endpoint *string `json:"endpoint,omitempty"`
	Bucket   *string `json:"bucket,omitempty"`
	Prefix   *string `json:"prefix,omitempty"`
}

// Sentinel errors so the HTTP layer can map to the right status code.
var (
	ErrNotFound       = errors.New("storage target not found")
	ErrBuiltinLocked  = errors.New("built-in storage targets cannot be modified")
	ErrInvalid        = errors.New("invalid storage target")
	ErrAlreadyExists  = errors.New("storage target already exists")
)

// Store is the in-memory backend. Concurrency-safe via a single RWMutex.
type Store struct {
	mu      sync.RWMutex
	targets map[string]Target
	nextID  int
	clock   func() time.Time
}

// New seeds the store with the same built-in targets the frontend used to
// ship as prototype data, so users running against a fresh backend see the
// same picker entries they did before this package existed.
func New(registryEndpoint string) *Store {
	s := &Store{
		targets: make(map[string]Target),
		clock:   func() time.Time { return time.Now().UTC() },
	}
	now := s.clock().Format(time.RFC3339)
	for _, t := range []Target{
		{
			Name:      "Built-in object store",
			Kind:      KindS3,
			Endpoint:  "minio.knaic-system.svc.cluster.local:9000",
			Bucket:    "knaic-models",
			Prefix:    "",
			Builtin:   true,
			CreatedAt: now,
		},
		{
			Name:      "Built-in OCI registry",
			Kind:      KindOCI,
			Endpoint:  registryEndpoint,
			Prefix:    "models",
			Builtin:   true,
			CreatedAt: now,
		},
	} {
		s.nextID++
		t.ID = idFor(s.nextID)
		s.targets[t.ID] = t
	}
	return s
}

// List returns every target ordered builtin-first then by creation order so
// the picker dropdown is stable across requests.
func (s *Store) List() []Target {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Target, 0, len(s.targets))
	for _, t := range s.targets {
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Builtin != out[j].Builtin {
			return out[i].Builtin
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Get returns one target by id. ErrNotFound when missing.
func (s *Store) Get(id string) (Target, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.targets[id]
	if !ok {
		return Target{}, ErrNotFound
	}
	return t, nil
}

// Create registers a new user-defined target. Built-in flag is always false
// here — built-ins only come from New().
func (s *Store) Create(in CreateInput) (Target, error) {
	if err := validateCreate(in); err != nil {
		return Target{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.targets {
		if t.Name == in.Name {
			return Target{}, ErrAlreadyExists
		}
	}
	s.nextID++
	t := Target{
		ID:        idFor(s.nextID),
		Name:      in.Name,
		Kind:      in.Kind,
		Endpoint:  in.Endpoint,
		Bucket:    in.Bucket,
		Prefix:    in.Prefix,
		Builtin:   false,
		CreatedAt: s.clock().Format(time.RFC3339),
	}
	s.targets[t.ID] = t
	return t, nil
}

// Patch updates the mutable fields on a non-builtin target. The kind isn't
// patchable — switching backends mid-life would invalidate every URI a model
// already points at, so callers must delete and re-create instead.
func (s *Store) Patch(id string, p PatchInput) (Target, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.targets[id]
	if !ok {
		return Target{}, ErrNotFound
	}
	if t.Builtin {
		return Target{}, ErrBuiltinLocked
	}
	if p.Name != nil {
		t.Name = *p.Name
	}
	if p.Endpoint != nil {
		t.Endpoint = *p.Endpoint
	}
	if p.Bucket != nil {
		t.Bucket = *p.Bucket
	}
	if p.Prefix != nil {
		t.Prefix = *p.Prefix
	}
	s.targets[id] = t
	return t, nil
}

// Delete removes a non-builtin target. Built-ins are pinned for the lifetime
// of the process — protecting them from a stray DELETE keeps the Model Hub
// picker from going empty if a user fat-fingers an admin call.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.targets[id]
	if !ok {
		return ErrNotFound
	}
	if t.Builtin {
		return ErrBuiltinLocked
	}
	delete(s.targets, id)
	return nil
}

func validateCreate(in CreateInput) error {
	if in.Name == "" {
		return errors.New("name is required")
	}
	switch in.Kind {
	case KindS3:
		if in.Endpoint == "" || in.Bucket == "" {
			return errors.New("s3 targets require endpoint and bucket")
		}
	case KindOCI:
		if in.Endpoint == "" {
			return errors.New("oci targets require endpoint")
		}
	case KindPVC:
		// PVC targets reuse the name as the PVC handle; endpoint is optional.
	default:
		return errors.New(`kind must be one of "s3", "oci", "pvc"`)
	}
	return nil
}

func idFor(n int) string {
	// Prefix keeps ids self-describing in logs and decouples the store's
	// internal counter from anything client-visible.
	return "st-" + strconv.Itoa(n)
}
