package publish

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/knaic/knaic-backend/internal/auth"
)

var ErrForbidden = errors.New("forbidden")

// ModelSnapshot is the slice of a Model that publish needs to (a) snapshot
// the private model into the request and (b) copy it into the public
// catalog on approval. Keeping it as an interface keeps internal/publish
// independent of internal/models so there's no import cycle.
type ModelSnapshot struct {
	ID        string
	Name      string
	Owner     string
	Namespace string
	URI       string
	ModelType string
	SizeGB    float64
	Tags      []string
	Readme    string
	SourceURL string
}

// ModelGateway is the minimal models contract publish needs.
type ModelGateway interface {
	GetPrivateForPublish(ctx context.Context, u *auth.User, id string) (ModelSnapshot, error)
	CreatePublicFromRequest(ctx context.Context, u *auth.User, req PublishCopyRequest) (publicModelID string, err error)
}

// PublishCopyRequest is the payload sent to ModelGateway.CreatePublicFromRequest
// when an admin approves. The gateway is responsible for validating uniqueness
// and applying the platform-admin write rules.
type PublishCopyRequest struct {
	Name         string
	Owner        string
	URI          string
	Tags         []string
	ModelType    string
	SizeGB       float64
	Readme       string
	CollectionID string
	SourceURL    string
}

// NamespaceAuthorizer mirrors models.NamespaceAuthorizer.
type NamespaceAuthorizer interface {
	CanWritePrivateModel(ctx context.Context, u *auth.User, namespace string) (bool, error)
}

type Service struct {
	store      Store
	models     ModelGateway
	authorizer NamespaceAuthorizer
}

func NewService(store Store, models ModelGateway, authorizer NamespaceAuthorizer) *Service {
	return &Service{store: store, models: models, authorizer: authorizer}
}

func (s *Service) List(ctx context.Context, u *auth.User, f ListFilter) ([]Request, error) {
	if u == nil {
		return nil, ErrForbidden
	}
	// Platform admins see everything. Other users can only list requests
	// for namespaces they have write access to (which matches who can
	// open a publish request in the first place).
	if !u.IsPlatformAdmin {
		if f.Namespace == "" {
			return nil, ErrForbidden
		}
		ok, err := s.canWriteNamespace(ctx, u, f.Namespace)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, ErrForbidden
		}
	}
	return s.store.List(ctx, f)
}

func (s *Service) Create(ctx context.Context, u *auth.User, req CreateRequest) (Request, error) {
	if u == nil {
		return Request{}, ErrForbidden
	}
	if req.PrivateModelID == "" {
		return Request{}, errors.New("privateModelId is required")
	}
	if req.TargetName == "" {
		return Request{}, errors.New("targetName is required")
	}
	snap, err := s.models.GetPrivateForPublish(ctx, u, req.PrivateModelID)
	if err != nil {
		return Request{}, err
	}
	if !IsPublicURI(snap.URI) {
		return Request{}, fmt.Errorf("model URI %q is not publicly accessible; only hf:// hf-mirror:// modelscope:// or http(s):// models may be published", snap.URI)
	}
	if snap.Namespace == "" {
		return Request{}, errors.New("only namespace-scoped (private) models may be published")
	}
	// Caller must be allowed to write to the private namespace; mirrors
	// the rule used when registering the model in the first place.
	ok, err := s.canWriteNamespace(ctx, u, snap.Namespace)
	if err != nil {
		return Request{}, err
	}
	if !ok {
		return Request{}, ErrForbidden
	}
	r := Request{
		ID:                 newID("pub"),
		PrivateModelID:     snap.ID,
		PrivateNamespace:   snap.Namespace,
		PrivateName:        snap.Name,
		PrivateURI:         snap.URI,
		TargetName:         req.TargetName,
		TargetCollectionID: req.TargetCollectionID,
		RequestedBy:        u.Name,
		Note:               req.Note,
		Status:             StatusPending,
	}
	return s.store.Create(ctx, r)
}

func (s *Service) Approve(ctx context.Context, u *auth.User, id string, body ReviewRequest) (Request, error) {
	if u == nil || !u.IsPlatformAdmin {
		return Request{}, ErrForbidden
	}
	current, err := s.store.Get(ctx, id)
	if err != nil {
		return Request{}, err
	}
	if current.Status != StatusPending {
		return Request{}, fmt.Errorf("request is %s; only pending requests can be approved", current.Status)
	}
	snap, err := s.models.GetPrivateForPublish(ctx, u, current.PrivateModelID)
	if err != nil {
		return Request{}, fmt.Errorf("fetch private model: %w", err)
	}
	publicID, err := s.models.CreatePublicFromRequest(ctx, u, PublishCopyRequest{
		Name:         current.TargetName,
		Owner:        snap.Owner,
		URI:          snap.URI,
		Tags:         snap.Tags,
		ModelType:    snap.ModelType,
		SizeGB:       snap.SizeGB,
		Readme:       snap.Readme,
		CollectionID: current.TargetCollectionID,
		SourceURL:    snap.SourceURL,
	})
	if err != nil {
		return Request{}, fmt.Errorf("create public model: %w", err)
	}
	return s.store.Update(ctx, id, func(r *Request) error {
		r.Status = StatusApproved
		r.ReviewedBy = u.Name
		r.ReviewerNote = body.ReviewerNote
		r.CatalogModelID = publicID
		return nil
	})
}

func (s *Service) Reject(ctx context.Context, u *auth.User, id string, body ReviewRequest) (Request, error) {
	if u == nil || !u.IsPlatformAdmin {
		return Request{}, ErrForbidden
	}
	current, err := s.store.Get(ctx, id)
	if err != nil {
		return Request{}, err
	}
	if current.Status != StatusPending {
		return Request{}, fmt.Errorf("request is %s; only pending requests can be rejected", current.Status)
	}
	return s.store.Update(ctx, id, func(r *Request) error {
		r.Status = StatusRejected
		r.ReviewedBy = u.Name
		r.ReviewerNote = body.ReviewerNote
		return nil
	})
}

func (s *Service) Delete(ctx context.Context, u *auth.User, id string) error {
	if u == nil {
		return ErrForbidden
	}
	current, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	// Admins can delete anything; owners can withdraw their own pending requests.
	if !u.IsPlatformAdmin {
		if current.RequestedBy != u.Name || current.Status != StatusPending {
			return ErrForbidden
		}
	}
	return s.store.Delete(ctx, id)
}

func (s *Service) canWriteNamespace(ctx context.Context, u *auth.User, namespace string) (bool, error) {
	if u.IsPlatformAdmin {
		return true, nil
	}
	if s.authorizer == nil {
		return false, nil
	}
	return s.authorizer.CanWritePrivateModel(ctx, u, namespace)
}

func newID(prefix string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + hex.EncodeToString(b[:])
}
