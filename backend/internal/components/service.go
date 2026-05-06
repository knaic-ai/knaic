package components

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
)

// Service is the high-level façade exposed to the API layer.
type Service struct {
	store    *Store
	helm     HelmClient
	detector *Detector
	log      *slog.Logger
}

func NewService(store *Store, helm HelmClient, detector *Detector, log *slog.Logger) *Service {
	return &Service{store: store, helm: helm, detector: detector, log: log}
}

// List returns the catalog snapshot WITHOUT running cluster detection. The
// status/managedBy/namespace fields reflect the last detection result (or
// NotInstalled on a cold store). The frontend follows up with parallel
// /components/{name}/status calls so the heavy cluster scan happens lazily
// and doesn't block the initial page paint.
func (s *Service) List(ctx context.Context) ([]Component, error) {
	return s.store.List(), nil
}

// Status runs live detection for one component and returns the updated entry.
// Internally uses a 5-second snapshot cache shared across goroutines so a
// burst of per-component requests only triggers one Helm/CSV listing.
func (s *Service) Status(ctx context.Context, name string) (Component, error) {
	return s.detector.DetectOne(ctx, s.store, name)
}

func (s *Service) Get(ctx context.Context, name string) (Component, error) {
	return s.store.Get(name)
}

func (s *Service) PatchVersion(ctx context.Context, name, version string) (Component, error) {
	return s.store.Update(name, func(c *Component) {
		// Only allow versions in the published list.
		for _, v := range c.Versions {
			if v == version {
				c.SelectedVersion = version
				return
			}
		}
	})
}

func (s *Service) Install(ctx context.Context, name string) (Component, error) {
	c, err := s.store.Get(name)
	if err != nil {
		return Component{}, err
	}
	if c.Status == StatusInstalled {
		return c, errors.New("already installed")
	}
	if !c.Embedded {
		return c, fmt.Errorf("component %q has no embedded chart; provide a chart archive on import", name)
	}
	s.store.Update(name, func(item *Component) { item.Status = StatusInstalling })

	rel, err := s.helm.Install(ctx, c)
	if err != nil {
		s.store.Update(name, func(item *Component) {
			item.Status = StatusFailed
			item.LastError = err.Error()
		})
		return s.store.Get(name)
	}
	s.log.Info("component installed",
		"name", name, "release", rel.Name, "namespace", rel.Namespace, "version", c.SelectedVersion)
	s.detector.invalidateSnapshot()
	return s.store.Update(name, func(item *Component) {
		item.Status = StatusInstalled
		item.Namespace = rel.Namespace
		item.ManagedBy = ManagedByKnaic
		item.LastError = ""
	})
}

func (s *Service) Uninstall(ctx context.Context, name string) (Component, error) {
	c, err := s.store.Get(name)
	if err != nil {
		return Component{}, err
	}
	if c.Status != StatusInstalled {
		return c, errors.New("component is not installed")
	}
	if c.ManagedBy != ManagedByKnaic {
		return c, errors.New("only knaic-managed components can be uninstalled here")
	}
	s.store.Update(name, func(item *Component) { item.Status = StatusInstalling })

	if err := s.helm.Uninstall(ctx, c); err != nil {
		s.store.Update(name, func(item *Component) {
			item.Status = StatusFailed
			item.LastError = err.Error()
		})
		return s.store.Get(name)
	}
	s.detector.invalidateSnapshot()
	return s.store.Update(name, func(item *Component) {
		item.Status = StatusNotInstalled
		item.ManagedBy = ""
		item.LastError = ""
	})
}

// Reconcile re-runs Helm upgrade against the currently selected version.
func (s *Service) Reconcile(ctx context.Context, name string) (Component, error) {
	c, err := s.store.Get(name)
	if err != nil {
		return Component{}, err
	}
	if c.Status != StatusInstalled {
		return c, errors.New("only installed components can be reconciled")
	}
	if !c.Embedded {
		return c, fmt.Errorf("component %q has no embedded chart", name)
	}
	if _, err := s.helm.Upgrade(ctx, c); err != nil {
		s.store.Update(name, func(item *Component) {
			item.Status = StatusFailed
			item.LastError = err.Error()
		})
		return s.store.Get(name)
	}
	return s.store.Update(name, func(item *Component) {
		item.Status = StatusInstalled
		item.LastError = ""
	})
}

func (s *Service) Import(ctx context.Context, req ImportRequest) (Component, error) {
	if req.Name == "" || req.Version == "" {
		return Component{}, errors.New("name and version are required")
	}
	return s.store.AddImported(req)
}

func (s *Service) Remove(ctx context.Context, name string) error {
	return s.store.Remove(name)
}
