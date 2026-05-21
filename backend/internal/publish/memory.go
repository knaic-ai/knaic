package publish

import (
	"context"
	"sort"
	"sync"
	"time"
)

type MemoryStore struct {
	mu    sync.RWMutex
	items map[string]Request
}

func NewMemoryStore() *MemoryStore { return &MemoryStore{items: make(map[string]Request)} }

func (s *MemoryStore) List(_ context.Context, f ListFilter) ([]Request, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Request, 0)
	for _, r := range s.items {
		if f.Status != "" && r.Status != f.Status {
			continue
		}
		if f.Namespace != "" && r.PrivateNamespace != f.Namespace {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *MemoryStore) Get(_ context.Context, id string) (Request, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.items[id]
	if !ok {
		return Request{}, ErrNotFound
	}
	return r, nil
}

func (s *MemoryStore) Create(_ context.Context, r Request) (Request, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.items[r.ID]; ok {
		return Request{}, ErrConflict
	}
	for _, existing := range s.items {
		if existing.PrivateModelID == r.PrivateModelID && existing.Status == StatusPending {
			return Request{}, ErrConflict
		}
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now().UTC()
	}
	if r.UpdatedAt.IsZero() {
		r.UpdatedAt = r.CreatedAt
	}
	s.items[r.ID] = r
	return r, nil
}

func (s *MemoryStore) Update(_ context.Context, id string, mutate func(*Request) error) (Request, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.items[id]
	if !ok {
		return Request{}, ErrNotFound
	}
	if err := mutate(&r); err != nil {
		return Request{}, err
	}
	r.UpdatedAt = time.Now().UTC()
	s.items[id] = r
	return r, nil
}

func (s *MemoryStore) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.items[id]; !ok {
		return ErrNotFound
	}
	delete(s.items, id)
	return nil
}
