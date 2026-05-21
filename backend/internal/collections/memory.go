package collections

import (
	"context"
	"sort"
	"sync"
	"time"
)

type MemoryStore struct {
	mu    sync.RWMutex
	items map[string]Collection
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{items: make(map[string]Collection)}
}

func (s *MemoryStore) List(_ context.Context, scope Scope, namespace string) ([]Collection, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Collection, 0)
	for _, c := range s.items {
		if c.Scope != scope {
			continue
		}
		if scope == ScopePrivate && c.Namespace != namespace {
			continue
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *MemoryStore) Get(_ context.Context, id string) (Collection, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.items[id]
	if !ok {
		return Collection{}, ErrNotFound
	}
	return c, nil
}

func (s *MemoryStore) Create(_ context.Context, c Collection) (Collection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.items[c.ID]; ok {
		return Collection{}, ErrConflict
	}
	for _, existing := range s.items {
		if existing.Scope == c.Scope && existing.Namespace == c.Namespace && existing.Name == c.Name {
			return Collection{}, ErrConflict
		}
	}
	if c.CreatedAt.IsZero() {
		c.CreatedAt = time.Now().UTC()
	}
	if c.UpdatedAt.IsZero() {
		c.UpdatedAt = c.CreatedAt
	}
	s.items[c.ID] = c
	return c, nil
}

func (s *MemoryStore) Update(_ context.Context, id string, mutate func(*Collection) error) (Collection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.items[id]
	if !ok {
		return Collection{}, ErrNotFound
	}
	if err := mutate(&c); err != nil {
		return Collection{}, err
	}
	c.UpdatedAt = time.Now().UTC()
	s.items[id] = c
	return c, nil
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
