package models

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/knaic/knaic-backend/internal/auth"
)

// ErrForbidden is returned when the caller lacks the privilege to write to
// the requested scope/namespace.
var ErrForbidden = errors.New("forbidden")

type Service struct {
	store      Store
	authorizer NamespaceAuthorizer
}

func NewService(s Store) *Service { return &Service{store: s} }

type NamespaceAuthorizer interface {
	CanWritePrivateModel(ctx context.Context, u *auth.User, namespace string) (bool, error)
}

func NewServiceWithAuthorizer(s Store, authorizer NamespaceAuthorizer) *Service {
	return &Service{store: s, authorizer: authorizer}
}

func (s *Service) List(ctx context.Context, scope Scope, namespace string) ([]Model, error) {
	if scope == ScopePrivate && namespace == "" {
		return nil, errors.New("namespace required for private scope")
	}
	return s.store.List(ctx, scope, namespace)
}

func (s *Service) Get(ctx context.Context, id string) (Model, error) {
	return s.store.Get(ctx, id)
}

func (s *Service) Create(ctx context.Context, u *auth.User, req CreateRequest) (Model, error) {
	if req.Name == "" || req.URI == "" {
		return Model{}, errors.New("name and uri are required")
	}
	scheme, err := ParseScheme(req.URI)
	if err != nil {
		return Model{}, err
	}
	if err := s.gateWrite(ctx, u, req.Scope, req.Namespace); err != nil {
		return Model{}, err
	}
	owner := req.Owner
	if owner == "" && u != nil {
		owner = u.Name
	}
	if req.ModelType == "" {
		req.ModelType = "llm"
	}
	createdAt := time.Now().UTC()
	sourceURL := req.SourceURL
	if sourceURL == "" {
		sourceURL = PublicSourceURL(req.URI)
	}
	m := Model{
		ID:            newID("m"),
		Name:          req.Name,
		Owner:         owner,
		Scope:         req.Scope,
		Namespace:     namespaceFor(req.Scope, req.Namespace),
		URI:           req.URI,
		Scheme:        scheme,
		Tags:          req.Tags,
		ModelType:     req.ModelType,
		SizeGB:        req.SizeGB,
		CreatedAt:     createdAt,
		UpdatedAt:     createdAt,
		Readme:        req.Readme,
		CollectionID:  req.CollectionID,
		ParentModelID: req.ParentModelID,
		DerivedKind:   req.DerivedKind,
		SourceURL:     sourceURL,
	}
	if m.Readme == "" {
		m.Readme = "# " + m.Name + "\n\n_Registered via knaic._"
	}
	return s.store.Create(ctx, m)
}

func (s *Service) Import(ctx context.Context, u *auth.User, req ImportRequest) (Model, error) {
	uri, name, err := normaliseImportURL(req.URL)
	if err != nil {
		return Model{}, err
	}
	if err := s.gateWrite(ctx, u, req.Scope, req.Namespace); err != nil {
		return Model{}, err
	}
	scheme, _ := ParseScheme(uri)
	owner := ""
	if u != nil {
		owner = u.Name
	}
	parts := strings.SplitN(name, "/", 2)
	if len(parts) == 2 {
		owner = parts[0]
	}
	createdAt := time.Now().UTC()
	m := Model{
		ID:        newID("m"),
		Name:      name,
		Owner:     owner,
		Scope:     req.Scope,
		Namespace: namespaceFor(req.Scope, req.Namespace),
		URI:       uri,
		Scheme:    scheme,
		Tags:      []string{"imported"},
		ModelType: "llm",
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
		Readme:    fmt.Sprintf("# %s\n\nImported from %s.", name, req.URL),
		SourceURL: PublicSourceURL(uri),
	}
	return s.store.Create(ctx, m)
}

func (s *Service) Upload(ctx context.Context, u *auth.User, req UploadRequest) (Model, error) {
	if req.Name == "" || req.TargetURI == "" {
		return Model{}, errors.New("name and targetUri are required")
	}
	scheme, err := ParseScheme(req.TargetURI)
	if err != nil {
		return Model{}, err
	}
	if err := s.gateWrite(ctx, u, req.Scope, req.Namespace); err != nil {
		return Model{}, err
	}
	owner := ""
	if u != nil {
		owner = u.Name
	}
	if req.ModelType == "" {
		req.ModelType = "llm"
	}
	tags := req.Tags
	if !slices.Contains(tags, "uploaded") {
		tags = append(tags, "uploaded")
	}
	createdAt := time.Now().UTC()
	m := Model{
		ID:        newID("m"),
		Name:      req.Name,
		Owner:     owner,
		Scope:     req.Scope,
		Namespace: namespaceFor(req.Scope, req.Namespace),
		URI:       req.TargetURI,
		Scheme:    scheme,
		Tags:      tags,
		ModelType: req.ModelType,
		SizeGB:    req.SizeGB,
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
		Readme:    req.Readme,
		SourceURL: PublicSourceURL(req.TargetURI),
	}
	if m.Readme == "" {
		m.Readme = fmt.Sprintf("# %s\n\nUploaded to %s.", m.Name, m.URI)
	}
	return s.store.Create(ctx, m)
}

func (s *Service) Patch(ctx context.Context, u *auth.User, id string, req PatchRequest) (Model, error) {
	current, err := s.store.Get(ctx, id)
	if err != nil {
		return Model{}, err
	}
	// IncDownloads is allowed for any authenticated user (it's just a
	// counter); other mutations follow the same scope-write rules as create.
	mutateScope := false
	if req.Readme != nil || len(req.Tags) > 0 ||
		req.CollectionID != nil || req.ParentModelID != nil ||
		req.DerivedKind != nil || req.SourceURL != nil {
		mutateScope = true
	}
	if mutateScope {
		if err := s.gateWrite(ctx, u, current.Scope, current.Namespace); err != nil {
			return Model{}, err
		}
	}
	return s.store.Update(ctx, id, func(m *Model) error {
		if req.Readme != nil {
			m.Readme = *req.Readme
		}
		if len(req.Tags) > 0 {
			m.Tags = req.Tags
		}
		if req.IncDownloads != nil {
			m.Downloads += *req.IncDownloads
		}
		if req.CollectionID != nil {
			m.CollectionID = *req.CollectionID
		}
		if req.ParentModelID != nil {
			m.ParentModelID = *req.ParentModelID
		}
		if req.DerivedKind != nil {
			m.DerivedKind = *req.DerivedKind
		}
		if req.SourceURL != nil {
			m.SourceURL = *req.SourceURL
		}
		return nil
	})
}

// PublishSnapshot is the slice of fields the publish workflow snapshots
// from a private model. We expose it here (instead of inside internal/publish)
// so publish can stay independent of internal/models — see PublishCopy below.
type PublishSnapshot struct {
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

// GetPrivateForPublish returns the snapshot needed to open or approve a
// publish request. The caller must have write access to the private
// namespace (same rule as Create).
func (s *Service) GetPrivateForPublish(ctx context.Context, u *auth.User, id string) (PublishSnapshot, error) {
	m, err := s.store.Get(ctx, id)
	if err != nil {
		return PublishSnapshot{}, err
	}
	if m.Scope != ScopePrivate {
		return PublishSnapshot{}, errors.New("only private models can be published")
	}
	if err := s.gateWrite(ctx, u, m.Scope, m.Namespace); err != nil {
		return PublishSnapshot{}, err
	}
	return PublishSnapshot{
		ID:        m.ID,
		Name:      m.Name,
		Owner:     m.Owner,
		Namespace: m.Namespace,
		URI:       m.URI,
		ModelType: m.ModelType,
		SizeGB:    m.SizeGB,
		Tags:      append([]string(nil), m.Tags...),
		Readme:    m.Readme,
		SourceURL: m.SourceURL,
	}, nil
}

// PublishCopy is the request publish uses to create the destination model
// in the public catalog. Caller must be platform admin (the publish service
// enforces this before calling here).
type PublishCopy struct {
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

// CreatePublicFromRequest creates a new public-scope model from an
// approved publish request. Returns the new model's ID. Requires
// u.IsPlatformAdmin = true.
func (s *Service) CreatePublicFromRequest(ctx context.Context, u *auth.User, req PublishCopy) (string, error) {
	if u == nil || !u.IsPlatformAdmin {
		return "", ErrForbidden
	}
	scheme, err := ParseScheme(req.URI)
	if err != nil {
		return "", err
	}
	if !IsPublicSource(req.URI) {
		return "", errors.New("URI must be publicly accessible to publish to catalog")
	}
	now := time.Now().UTC()
	if req.ModelType == "" {
		req.ModelType = "llm"
	}
	tags := append([]string(nil), req.Tags...)
	if !slices.Contains(tags, "published") {
		tags = append(tags, "published")
	}
	m := Model{
		ID:           newID("m"),
		Name:         req.Name,
		Owner:        req.Owner,
		Scope:        ScopePublic,
		URI:          req.URI,
		Scheme:       scheme,
		Tags:         tags,
		ModelType:    req.ModelType,
		SizeGB:       req.SizeGB,
		CreatedAt:    now,
		UpdatedAt:    now,
		Readme:       req.Readme,
		CollectionID: req.CollectionID,
		SourceURL:    req.SourceURL,
	}
	if m.Readme == "" {
		m.Readme = "# " + m.Name + "\n\n_Published from a private model via knaic._"
	}
	if m.SourceURL == "" {
		m.SourceURL = PublicSourceURL(req.URI)
	}
	created, err := s.store.Create(ctx, m)
	if err != nil {
		return "", err
	}
	return created.ID, nil
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

// gateWrite enforces the scope/namespace authorisation rules:
//   - public scope writes require platform-admin
//   - private scope writes require platform-admin or namespace membership
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
		allowed, err := s.authorizer.CanWritePrivateModel(ctx, u, namespace)
		if err != nil {
			return err
		}
		if !allowed {
			return ErrForbidden
		}
		return nil
	default:
		return fmt.Errorf("unknown scope %q", scope)
	}
}

// ParseScheme inspects a model URI and returns its scheme.
func ParseScheme(uri string) (Scheme, error) {
	switch {
	case strings.HasPrefix(uri, "hf://"),
		strings.HasPrefix(uri, "hf-mirror://"),
		strings.HasPrefix(uri, "hf-local://"):
		return SchemeHF, nil
	case strings.HasPrefix(uri, "modelscope://"):
		return SchemeModelScope, nil
	case strings.HasPrefix(uri, "s3://"):
		return SchemeS3, nil
	case strings.HasPrefix(uri, "oci://"):
		return SchemeOCI, nil
	case strings.HasPrefix(uri, "gitlab://"):
		return SchemeGitLab, nil
	case strings.HasPrefix(uri, "pvc://"):
		return SchemePVC, nil
	case strings.HasPrefix(uri, "git://"):
		return SchemeGit, nil
	default:
		return "", fmt.Errorf("unsupported URI scheme; use hf:// hf-mirror:// hf-local:// modelscope:// s3:// oci:// gitlab:// pvc:// or git://")
	}
}

// PublicSourceURL returns the canonical web URL for an upstream model URI,
// or "" when the URI scheme is not a known public source.
//   hf://owner/name              → https://huggingface.co/owner/name
//   hf-mirror://owner/name       → https://hf-mirror.com/owner/name
//   hf-local://owner/name        → ""  (local cache, no public page)
//   modelscope://owner/name      → https://www.modelscope.cn/models/owner/name
func PublicSourceURL(uri string) string {
	switch {
	case strings.HasPrefix(uri, "hf://"):
		return "https://huggingface.co/" + strings.TrimPrefix(uri, "hf://")
	case strings.HasPrefix(uri, "hf-mirror://"):
		return "https://hf-mirror.com/" + strings.TrimPrefix(uri, "hf-mirror://")
	case strings.HasPrefix(uri, "modelscope://"):
		return "https://www.modelscope.cn/models/" + strings.TrimPrefix(uri, "modelscope://")
	default:
		return ""
	}
}

// IsPublicSource reports whether the URI scheme is reachable without
// per-namespace credentials. Only such models can be published from the
// private scope into the public catalog.
func IsPublicSource(uri string) bool {
	return strings.HasPrefix(uri, "hf://") ||
		strings.HasPrefix(uri, "hf-mirror://") ||
		strings.HasPrefix(uri, "modelscope://") ||
		strings.HasPrefix(uri, "http://") ||
		strings.HasPrefix(uri, "https://")
}

func namespaceFor(scope Scope, ns string) string {
	if scope == ScopePrivate {
		return ns
	}
	return ""
}

// normaliseImportURL turns an HF/MS web URL into a (scheme://owner/name, name) pair.
func normaliseImportURL(raw string) (uri string, name string, err error) {
	u, parseErr := url.Parse(raw)
	if parseErr != nil {
		return "", "", fmt.Errorf("invalid url: %w", parseErr)
	}
	host := strings.ToLower(u.Host)
	path := strings.Trim(u.Path, "/")
	switch {
	case strings.HasSuffix(host, "huggingface.co"):
		if path == "" {
			return "", "", errors.New("URL must include the model owner/name path")
		}
		return "hf://" + path, path, nil
	case strings.HasSuffix(host, "modelscope.cn"):
		// Accepted forms:
		//   https://www.modelscope.cn/models/<owner>/<name>
		//   https://www.modelscope.cn/<owner>/<name>
		path = strings.TrimPrefix(path, "models/")
		if path == "" {
			return "", "", errors.New("URL must include the model owner/name path")
		}
		return "modelscope://" + path, path, nil
	default:
		return "", "", errors.New("URL must be from huggingface.co or modelscope.cn")
	}
}
