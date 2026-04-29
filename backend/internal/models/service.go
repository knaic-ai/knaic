package models

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"

	"github.com/alauda/knaic-backend/internal/auth"
)

// ErrForbidden is returned when the caller lacks the privilege to write to
// the requested scope/namespace.
var ErrForbidden = errors.New("forbidden")

type Service struct {
	store Store
}

func NewService(s Store) *Service { return &Service{store: s} }

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
	if err := s.gateWrite(u, req.Scope, req.Namespace); err != nil {
		return Model{}, err
	}
	owner := req.Owner
	if owner == "" && u != nil {
		owner = u.Name
	}
	if req.ModelType == "" {
		req.ModelType = "llm"
	}
	m := Model{
		ID:        newID("m"),
		Name:      req.Name,
		Owner:     owner,
		Scope:     req.Scope,
		Namespace: namespaceFor(req.Scope, req.Namespace),
		URI:       req.URI,
		Scheme:    scheme,
		Tags:      req.Tags,
		ModelType: req.ModelType,
		SizeGB:    req.SizeGB,
		Readme:    req.Readme,
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
	if err := s.gateWrite(u, req.Scope, req.Namespace); err != nil {
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
		Readme:    fmt.Sprintf("# %s\n\nImported from %s.", name, req.URL),
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
	if err := s.gateWrite(u, req.Scope, req.Namespace); err != nil {
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
		Readme:    req.Readme,
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
	if req.Readme != nil || len(req.Tags) > 0 {
		mutateScope = true
	}
	if mutateScope {
		if err := s.gateWrite(u, current.Scope, current.Namespace); err != nil {
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
		return nil
	})
}

func (s *Service) Delete(ctx context.Context, u *auth.User, id string) error {
	current, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if err := s.gateWrite(u, current.Scope, current.Namespace); err != nil {
		return err
	}
	return s.store.Delete(ctx, id)
}

// gateWrite enforces the scope/namespace authorisation rules:
//   - public scope writes require platform-admin
//   - private scope writes require platform-admin or namespace membership
func (s *Service) gateWrite(u *auth.User, scope Scope, namespace string) error {
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
		// The OIDC verifier may not provide per-namespace membership
		// claims; for now we trust any authenticated user for private
		// writes scoped to a namespace they reference. The Users / RBAC
		// slice will tighten this via SubjectAccessReview.
		return nil
	default:
		return fmt.Errorf("unknown scope %q", scope)
	}
}

// ParseScheme inspects a model URI and returns its scheme.
func ParseScheme(uri string) (Scheme, error) {
	switch {
	case strings.HasPrefix(uri, "hf://"):
		return SchemeHF, nil
	case strings.HasPrefix(uri, "modelscope://"):
		return SchemeModelScope, nil
	case strings.HasPrefix(uri, "s3://"):
		return SchemeS3, nil
	case strings.HasPrefix(uri, "oci://"):
		return SchemeOCI, nil
	default:
		return "", fmt.Errorf("unsupported URI scheme; use hf:// modelscope:// s3:// or oci://")
	}
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
