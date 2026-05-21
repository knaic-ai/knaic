package publish

import (
	"context"
	"errors"
)

var (
	ErrNotFound = errors.New("publish request not found")
	ErrConflict = errors.New("publish request already exists")
)

// ListFilter narrows the list to a specific status and/or namespace.
// Empty Status/Namespace means "any".
type ListFilter struct {
	Status    Status
	Namespace string
}

type Store interface {
	List(ctx context.Context, f ListFilter) ([]Request, error)
	Get(ctx context.Context, id string) (Request, error)
	Create(ctx context.Context, r Request) (Request, error)
	Update(ctx context.Context, id string, mutate func(*Request) error) (Request, error)
	Delete(ctx context.Context, id string) error
}
