package collections

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/knaic/knaic-backend/internal/auth"
)

var ErrForbidden = errors.New("forbidden")

type Service struct {
	store      Store
	authorizer NamespaceAuthorizer
}

// NamespaceAuthorizer mirrors models.NamespaceAuthorizer so collections
// can use the same RBAC gate without depending on the models package.
type NamespaceAuthorizer interface {
	CanWritePrivateModel(ctx context.Context, u *auth.User, namespace string) (bool, error)
}

func NewService(s Store) *Service { return &Service{store: s} }
func NewServiceWithAuthorizer(s Store, a NamespaceAuthorizer) *Service {
	return &Service{store: s, authorizer: a}
}

func (s *Service) List(ctx context.Context, scope Scope, namespace string) ([]Collection, error) {
	if scope == ScopePrivate && namespace == "" {
		return nil, errors.New("namespace required for private scope")
	}
	return s.store.List(ctx, scope, namespace)
}

func (s *Service) Get(ctx context.Context, id string) (Collection, error) {
	return s.store.Get(ctx, id)
}

func (s *Service) Create(ctx context.Context, u *auth.User, req CreateRequest) (Collection, error) {
	if req.Name == "" {
		return Collection{}, errors.New("name is required")
	}
	if err := s.gateWrite(ctx, u, req.Scope, req.Namespace); err != nil {
		return Collection{}, err
	}
	owner := ""
	if u != nil {
		owner = u.Name
	}
	c := Collection{
		ID:          req.ID,
		Name:        req.Name,
		Owner:       owner,
		Scope:       req.Scope,
		Namespace:   namespaceFor(req.Scope, req.Namespace),
		Description: req.Description,
		IconColor:   req.IconColor,
	}
	if c.ID == "" {
		c.ID = newID("col")
	}
	return s.store.Create(ctx, c)
}

func (s *Service) Patch(ctx context.Context, u *auth.User, id string, req PatchRequest) (Collection, error) {
	current, err := s.store.Get(ctx, id)
	if err != nil {
		return Collection{}, err
	}
	if err := s.gateWrite(ctx, u, current.Scope, current.Namespace); err != nil {
		return Collection{}, err
	}
	return s.store.Update(ctx, id, func(c *Collection) error {
		if req.Name != nil {
			c.Name = *req.Name
		}
		if req.Description != nil {
			c.Description = *req.Description
		}
		if req.IconColor != nil {
			c.IconColor = *req.IconColor
		}
		return nil
	})
}

func (s *Service) Delete(ctx context.Context, u *auth.User, id string) error {
	current, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if err := s.gateWrite(ctx, u, current.Scope, current.Namespace); err != nil {
		return err
	}
	return s.store.Delete(ctx, id)
}

// SeedPublic upserts a public-scope collection. Used by the models seed
// pipeline. Returns nil if the collection already exists.
func (s *Service) SeedPublic(ctx context.Context, c Collection) error {
	c.Scope = ScopePublic
	c.Namespace = ""
	if c.ID == "" {
		c.ID = newID("col")
	}
	_, err := s.store.Create(ctx, c)
	if errors.Is(err, ErrConflict) {
		return nil
	}
	return err
}

func (s *Service) gateWrite(ctx context.Context, u *auth.User, scope Scope, namespace string) error {
	if u == nil {
		return ErrForbidden
	}
	if u.IsPlatformAdmin {
		return nil
	}
	switch scope {
	case ScopePublic:
		return ErrForbidden
	case ScopePrivate:
		if namespace == "" {
			return errors.New("namespace required for private scope")
		}
		if s.authorizer == nil {
			return ErrForbidden
		}
		ok, err := s.authorizer.CanWritePrivateModel(ctx, u, namespace)
		if err != nil {
			return err
		}
		if !ok {
			return ErrForbidden
		}
		return nil
	default:
		return fmt.Errorf("unknown scope %q", scope)
	}
}

func namespaceFor(scope Scope, ns string) string {
	if scope == ScopePrivate {
		return ns
	}
	return ""
}

func newID(prefix string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + hex.EncodeToString(b[:])
}
