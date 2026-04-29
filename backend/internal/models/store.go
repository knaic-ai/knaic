package models

import (
	"context"
	"errors"
)

// ErrNotFound is returned when a model id is unknown.
var ErrNotFound = errors.New("model not found")

// ErrConflict is returned when a unique constraint fails (same name in same
// scope/namespace).
var ErrConflict = errors.New("model already exists")

// Store is the persistence façade. Implementations: in-memory (default) and
// Postgres (when KNAIC_DB_URL is set). All methods take ctx so cancellations
// propagate cleanly through HTTP handlers.
type Store interface {
	List(ctx context.Context, scope Scope, namespace string) ([]Model, error)
	Get(ctx context.Context, id string) (Model, error)
	Create(ctx context.Context, m Model) (Model, error)
	Update(ctx context.Context, id string, mutate func(*Model) error) (Model, error)
	Delete(ctx context.Context, id string) error
	Count(ctx context.Context, scope Scope) (int, error)
}
