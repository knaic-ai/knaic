package collections

import (
	"context"
	"errors"
)

var (
	ErrNotFound = errors.New("collection not found")
	ErrConflict = errors.New("collection already exists")
)

type Store interface {
	List(ctx context.Context, scope Scope, namespace string) ([]Collection, error)
	Get(ctx context.Context, id string) (Collection, error)
	Create(ctx context.Context, c Collection) (Collection, error)
	Update(ctx context.Context, id string, mutate func(*Collection) error) (Collection, error)
	Delete(ctx context.Context, id string) error
}
