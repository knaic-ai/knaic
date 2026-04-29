package components

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/cli"
	"helm.sh/helm/v3/pkg/release"
	"k8s.io/cli-runtime/pkg/genericclioptions"
)

// ReleaseNamePrefix tags every Helm release knaic creates so we can tell
// them apart from releases installed by other tools.
const (
	ReleaseNamePrefix   = "knaic-"
	ManagedByLabel      = "knaic.io/managed"
	ManagedByLabelValue = "true"
	ComponentLabel      = "knaic.io/component"
	HelmStorageDriver   = "secret"
)

// HelmClient is the interface the components service uses for Helm operations.
// It is small on purpose so it can be faked in tests.
type HelmClient interface {
	Install(ctx context.Context, comp Component) (*release.Release, error)
	Upgrade(ctx context.Context, comp Component) (*release.Release, error)
	Uninstall(ctx context.Context, comp Component) error
	ListAll(ctx context.Context) ([]*release.Release, error)
}

type helmImpl struct {
	getter genericclioptions.RESTClientGetter
	loader func(name string) (*chart.Chart, error)
	log    *slog.Logger

	cfgs   map[string]*action.Configuration
	cfgsMu sync.Mutex
}

// NewHelmClient builds the production Helm client. The loader function
// resolves a component name to its embedded chart.
func NewHelmClient(getter genericclioptions.RESTClientGetter, loader func(name string) (*chart.Chart, error), log *slog.Logger) HelmClient {
	return &helmImpl{
		getter: getter,
		loader: loader,
		log:    log,
		cfgs:   make(map[string]*action.Configuration),
	}
}

func (h *helmImpl) configFor(namespace string) (*action.Configuration, error) {
	h.cfgsMu.Lock()
	defer h.cfgsMu.Unlock()
	if cfg, ok := h.cfgs[namespace]; ok {
		return cfg, nil
	}
	cfg := new(action.Configuration)
	settings := cli.New()
	settings.SetNamespace(namespace)
	debug := func(format string, v ...any) {
		h.log.Debug(fmt.Sprintf(format, v...))
	}
	if err := cfg.Init(h.getter, namespace, HelmStorageDriver, debug); err != nil {
		return nil, fmt.Errorf("helm action init for %q: %w", namespace, err)
	}
	h.cfgs[namespace] = cfg
	return cfg, nil
}

func (h *helmImpl) Install(ctx context.Context, comp Component) (*release.Release, error) {
	chrt, err := h.loader(comp.Name)
	if err != nil {
		return nil, err
	}
	cfg, err := h.configFor(comp.Namespace)
	if err != nil {
		return nil, err
	}
	inst := action.NewInstall(cfg)
	inst.ReleaseName = ReleaseNamePrefix + comp.Name
	inst.Namespace = comp.Namespace
	inst.CreateNamespace = true
	inst.Labels = map[string]string{
		ManagedByLabel: ManagedByLabelValue,
		ComponentLabel: comp.Name,
	}
	inst.Wait = false
	rel, err := inst.RunWithContext(ctx, chrt, defaultValues(comp))
	if err != nil {
		return nil, fmt.Errorf("helm install %s: %w", comp.Name, err)
	}
	return rel, nil
}

func (h *helmImpl) Upgrade(ctx context.Context, comp Component) (*release.Release, error) {
	chrt, err := h.loader(comp.Name)
	if err != nil {
		return nil, err
	}
	cfg, err := h.configFor(comp.Namespace)
	if err != nil {
		return nil, err
	}
	up := action.NewUpgrade(cfg)
	up.Namespace = comp.Namespace
	up.Labels = map[string]string{
		ManagedByLabel: ManagedByLabelValue,
		ComponentLabel: comp.Name,
	}
	rel, err := up.RunWithContext(ctx, ReleaseNamePrefix+comp.Name, chrt, defaultValues(comp))
	if err != nil {
		return nil, fmt.Errorf("helm upgrade %s: %w", comp.Name, err)
	}
	return rel, nil
}

func (h *helmImpl) Uninstall(ctx context.Context, comp Component) error {
	cfg, err := h.configFor(comp.Namespace)
	if err != nil {
		return err
	}
	un := action.NewUninstall(cfg)
	if _, err := un.Run(ReleaseNamePrefix + comp.Name); err != nil {
		return fmt.Errorf("helm uninstall %s: %w", comp.Name, err)
	}
	return nil
}

func (h *helmImpl) ListAll(ctx context.Context) ([]*release.Release, error) {
	// We use the empty-namespace config for AllNamespaces=true.
	cfg, err := h.configFor("")
	if err != nil {
		return nil, err
	}
	list := action.NewList(cfg)
	list.AllNamespaces = true
	list.All = true
	return list.Run()
}

// defaultValues builds the values overrides that knaic sets on every release.
// We pin the image tag to the user-selected version so the chart's appVersion
// is overridden when the operator picks a different version in the UI.
func defaultValues(comp Component) map[string]any {
	v := strings.TrimPrefix(comp.SelectedVersion, "v")
	return map[string]any{
		"image": map[string]any{
			"tag": v,
		},
		"knaic": map[string]any{
			"managed":   true,
			"component": comp.Name,
		},
	}
}

// IsKnaicRelease reports whether the given release was created by knaic, by
// checking the release name prefix and any labels we set at install time.
func IsKnaicRelease(rel *release.Release) bool {
	if rel == nil {
		return false
	}
	if strings.HasPrefix(rel.Name, ReleaseNamePrefix) {
		return true
	}
	if v, ok := rel.Labels[ManagedByLabel]; ok && v == ManagedByLabelValue {
		return true
	}
	return false
}
