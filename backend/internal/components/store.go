package components

import (
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/alauda/knaic-backend/internal/charts"
)

// ErrNotFound is returned when a component name is unknown.
var ErrNotFound = errors.New("component not found")

// Store holds the in-memory view of components. The Helm release state on
// the cluster is the source of truth — Refresh reconciles the store to it.
type Store struct {
	mu              sync.RWMutex
	items           map[string]*Component
	systemNamespace string
}

func NewStore(systemNamespace string) *Store {
	s := &Store{
		items:           make(map[string]*Component),
		systemNamespace: systemNamespace,
	}
	for _, c := range builtinCatalog() {
		c := c
		c.Namespace = systemNamespace
		c.Embedded = charts.Has(c.Name)
		s.items[c.Name] = &c
	}
	return s
}

// List returns a deterministic snapshot of all components.
func (s *Store) List() []Component {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Component, 0, len(s.items))
	for _, c := range s.items {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns a copy of a single component.
func (s *Store) Get(name string) (Component, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.items[name]
	if !ok {
		return Component{}, ErrNotFound
	}
	return *c, nil
}

// Update applies a mutation under the store lock. The function receives a
// pointer to the live entry; modifications are persisted in place.
func (s *Store) Update(name string, fn func(*Component)) (Component, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.items[name]
	if !ok {
		return Component{}, ErrNotFound
	}
	fn(c)
	c.LastTransition = time.Now().UTC()
	return *c, nil
}

// AddImported registers a non-builtin Helm chart as an installable component.
func (s *Store) AddImported(req ImportRequest) (Component, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.items[req.Name]; exists {
		return Component{}, errors.New("component name already exists")
	}
	ns := req.Namespace
	if ns == "" {
		ns = s.systemNamespace
	}
	disp := req.DisplayName
	if disp == "" {
		disp = req.Name
	}
	cat := req.Category
	if cat == "" {
		cat = CategoryInference
	}
	c := &Component{
		Name:            req.Name,
		DisplayName:     disp,
		Description:     req.Description,
		Category:        cat,
		Versions:        []string{req.Version},
		SelectedVersion: req.Version,
		Status:          StatusNotInstalled,
		Namespace:       ns,
		Images:          req.Images,
		ImageSync:       SyncPending,
		Builtin:         false,
		Embedded:        false,
		LastTransition:  time.Now().UTC(),
	}
	s.items[req.Name] = c
	return *c, nil
}

// Remove deletes a non-builtin component entry.
func (s *Store) Remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.items[name]
	if !ok {
		return ErrNotFound
	}
	if c.Builtin {
		return errors.New("cannot remove builtin component")
	}
	delete(s.items, name)
	return nil
}

// SystemNamespace returns the namespace where built-in components install.
func (s *Store) SystemNamespace() string { return s.systemNamespace }
