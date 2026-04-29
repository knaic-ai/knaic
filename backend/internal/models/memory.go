package models

import (
	"context"
	"sort"
	"sync"
	"time"
)

type MemoryStore struct {
	mu    sync.RWMutex
	items map[string]Model
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{items: make(map[string]Model)}
}

func (s *MemoryStore) List(_ context.Context, scope Scope, namespace string) ([]Model, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Model, 0)
	for _, m := range s.items {
		if m.Scope != scope {
			continue
		}
		if scope == ScopePrivate && m.Namespace != namespace {
			continue
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func (s *MemoryStore) Get(_ context.Context, id string) (Model, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.items[id]
	if !ok {
		return Model{}, ErrNotFound
	}
	return m, nil
}

func (s *MemoryStore) Create(_ context.Context, m Model) (Model, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.items {
		if existing.Scope == m.Scope && existing.Namespace == m.Namespace && existing.Name == m.Name {
			return Model{}, ErrConflict
		}
	}
	if m.UpdatedAt.IsZero() {
		m.UpdatedAt = time.Now().UTC()
	}
	s.items[m.ID] = m
	return m, nil
}

func (s *MemoryStore) Update(_ context.Context, id string, mutate func(*Model) error) (Model, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.items[id]
	if !ok {
		return Model{}, ErrNotFound
	}
	if err := mutate(&m); err != nil {
		return Model{}, err
	}
	m.UpdatedAt = time.Now().UTC()
	s.items[id] = m
	return m, nil
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

func (s *MemoryStore) Count(_ context.Context, scope Scope) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, m := range s.items {
		if m.Scope == scope {
			n++
		}
	}
	return n, nil
}
