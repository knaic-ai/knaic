package components

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

// Detector resolves the live install state of a single component:
//   - releases knaic owns (label match)        -> Installed / knaic
//   - releases of the same chart (any owner)   -> Installed / manual
//   - operator-installed (CSV present)         -> Installed / OLM
//   - matching Deployment exists               -> Installed / manual
//   - none of the above                        -> NotInstalled
//
// All listings (Helm, OLM CSV, deployments) are taken once per snapshotTTL
// window and cached so N parallel per-component requests share one cluster
// scan.
type Detector struct {
	helm  HelmClient
	typed kubernetes.Interface
	dyn   dynamic.Interface

	snapMu      sync.Mutex
	snap        *clusterSnapshot
	snapExpires time.Time
	snapTTL     time.Duration
}

func NewDetector(helm HelmClient, typed kubernetes.Interface, dyn dynamic.Interface) *Detector {
	return &Detector{
		helm:    helm,
		typed:   typed,
		dyn:     dyn,
		snapTTL: 5 * time.Second,
	}
}

// helmReleaseHit captures the bits of a release the detector cares about.
type helmReleaseHit struct {
	name      string
	namespace string
	owner     ManagedBy
}

// csvHit captures a discovered ClusterServiceVersion.
type csvHit struct {
	name      string
	namespace string
}

// appReleaseHit captures an Alauda ACP AppRelease (operator.alauda.io/v1alpha1)
// that owns one or more Helm releases.
type appReleaseHit struct {
	name      string
	namespace string
}

type clusterSnapshot struct {
	releasesByChart   map[string][]helmReleaseHit
	csvs              []csvHit
	deploymentsByComp map[string]string        // component label value -> namespace
	appReleases       map[string]appReleaseHit // any of: AppRelease name / chart releaseName / chart name suffix -> hit
	helmErr           error
	csvErr            error
}

// snapshot returns a cached cluster scan. Multiple goroutines firing within
// snapTTL share the same scan.
func (d *Detector) snapshot(ctx context.Context) *clusterSnapshot {
	d.snapMu.Lock()
	defer d.snapMu.Unlock()
	if d.snap != nil && time.Now().Before(d.snapExpires) {
		return d.snap
	}
	snap := &clusterSnapshot{
		releasesByChart: map[string][]helmReleaseHit{},
	}
	if d.helm != nil {
		releases, err := d.helm.ListAll(ctx)
		if err != nil {
			snap.helmErr = err
		} else {
			for _, rel := range releases {
				if rel == nil || rel.Chart == nil || rel.Chart.Metadata == nil {
					continue
				}
				owner := ManagedByManual
				if IsKnaicRelease(rel) {
					owner = ManagedByKnaic
				}
				ch := rel.Chart.Metadata.Name
				snap.releasesByChart[ch] = append(snap.releasesByChart[ch], helmReleaseHit{
					name:      rel.Name,
					namespace: rel.Namespace,
					owner:     owner,
				})
			}
		}
	}
	if d.dyn != nil {
		hits, err := d.listCSVs(ctx)
		if err != nil {
			snap.csvErr = err
		} else {
			snap.csvs = hits
		}
		snap.appReleases = d.listAppReleases(ctx)
	}
	if d.typed != nil {
		// One cluster-wide LIST keyed on the knaic component label, instead
		// of N×namespace per-component lookups. Deployments installed via
		// Helm/OLM also wear this label (knaic itself stamps it on Install),
		// so we don't need separate per-namespace fallbacks.
		snap.deploymentsByComp = map[string]string{}
		dep, err := d.typed.AppsV1().Deployments(metav1.NamespaceAll).List(ctx, metav1.ListOptions{
			LabelSelector: ComponentLabel,
		})
		if err == nil {
			for _, item := range dep.Items {
				comp := item.Labels[ComponentLabel]
				if comp == "" {
					continue
				}
				if _, seen := snap.deploymentsByComp[comp]; !seen {
					snap.deploymentsByComp[comp] = item.Namespace
				}
			}
		}
	}
	d.snap = snap
	d.snapExpires = time.Now().Add(d.snapTTL)
	return snap
}

// invalidateSnapshot forces the next snapshot() call to re-scan. Called after
// install/uninstall so the user sees their action reflected immediately.
func (d *Detector) invalidateSnapshot() {
	d.snapMu.Lock()
	d.snap = nil
	d.snapMu.Unlock()
}

// DetectOne resolves the live state of a single component using the cached
// snapshot. Mutates the store entry in-place and returns the updated copy.
func (d *Detector) DetectOne(ctx context.Context, store *Store, name string) (Component, error) {
	c, err := store.Get(name)
	if err != nil {
		return Component{}, err
	}
	snap := d.snapshot(ctx)

	// Skip transient states — the install/uninstall handlers own those.
	if c.Status == StatusInstalling {
		return c, nil
	}

	// Priority: knaic-owned Helm > ACP AppRelease > raw Helm > OLM CSV >
	// labeled Deployment. AppRelease is checked before "raw Helm" because an
	// AppRelease *creates* a Helm release; reporting "ACP" is more useful
	// than the generic "manual" we'd otherwise infer from that same release.
	if hits := snap.releasesByChart[c.Name]; len(hits) > 0 {
		for _, h := range hits {
			if h.owner == ManagedByKnaic {
				return store.Update(name, func(item *Component) {
					item.Status = StatusInstalled
					item.Namespace = h.namespace
					item.ManagedBy = ManagedByKnaic
					item.Notes = ""
				})
			}
		}
	}
	if hit, ok := snap.appReleases[c.Name]; ok {
		return store.Update(name, func(item *Component) {
			item.Status = StatusInstalled
			item.Namespace = hit.namespace
			item.ManagedBy = ManagedByACP
			item.Notes = fmt.Sprintf("Managed by ACP AppRelease %q in %q.", hit.name, hit.namespace)
		})
	}
	if hits := snap.releasesByChart[c.Name]; len(hits) > 0 {
		chosen := hits[0]
		return store.Update(name, func(item *Component) {
			item.Status = StatusInstalled
			item.Namespace = chosen.namespace
			item.ManagedBy = chosen.owner
			item.Notes = fmt.Sprintf("Helm release %q in %q (not installed by knaic).", chosen.name, chosen.namespace)
		})
	}
	if csv, ok := matchCSV(c.Name, snap.csvs); ok {
		return store.Update(name, func(item *Component) {
			item.Status = StatusInstalled
			item.Namespace = csv.namespace
			item.ManagedBy = ManagedByOLM
			item.Notes = fmt.Sprintf("Detected via OLM ClusterServiceVersion %q in %q.", csv.name, csv.namespace)
		})
	}
	if ns := snap.deploymentsByComp[c.Name]; ns != "" {
		return store.Update(name, func(item *Component) {
			item.Status = StatusInstalled
			item.Namespace = ns
			item.ManagedBy = ManagedByManual
			item.Notes = fmt.Sprintf("Deployment with %s=%s label found in %q.", ComponentLabel, c.Name, ns)
		})
	}

	return store.Update(name, func(item *Component) {
		item.Status = StatusNotInstalled
		item.ManagedBy = ""
		item.Notes = ""
		// Reset namespace back to the default install target.
		if store.SystemNamespace() != "" {
			item.Namespace = store.SystemNamespace()
		}
	})
}

// listAppReleases returns an index of Alauda ACP AppReleases keyed on every
// alias the detector might match a component against:
//   - AppRelease metadata.name                  (e.g. "mlflow")
//   - spec.source.charts[*].releaseName         (e.g. "kubeflow-trainer")
//   - chart name with the leading "chart-" stripped, e.g. "chart-lws" -> "lws"
//
// First write wins so the AppRelease's own metadata.name takes precedence.
// Returns an empty map if the CRD isn't installed (common on non-ACP clusters).
func (d *Detector) listAppReleases(ctx context.Context) map[string]appReleaseHit {
	gvr := schema.GroupVersionResource{
		Group:    "operator.alauda.io",
		Version:  "v1alpha1",
		Resource: "appreleases",
	}
	list, err := d.dyn.Resource(gvr).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil
	}
	out := map[string]appReleaseHit{}
	add := func(key string, hit appReleaseHit) {
		key = strings.TrimSpace(key)
		if key == "" {
			return
		}
		if _, exists := out[key]; !exists {
			out[key] = hit
		}
	}
	for _, item := range list.Items {
		hit := appReleaseHit{name: item.GetName(), namespace: item.GetNamespace()}
		add(item.GetName(), hit)
		charts, _, _ := unstructuredNestedSlice(item.Object, "spec", "source", "charts")
		for _, raw := range charts {
			m, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if rn, ok := m["releaseName"].(string); ok {
				add(rn, hit)
			}
			if cn, ok := m["name"].(string); ok {
				// "acp/chart-cert-manager" -> "cert-manager"
				if i := strings.LastIndex(cn, "/"); i >= 0 {
					cn = cn[i+1:]
				}
				cn = strings.TrimPrefix(cn, "chart-")
				add(cn, hit)
			}
		}
	}
	return out
}

// unstructuredNestedSlice mirrors unstructured.NestedSlice without dragging
// in the apimachinery import for this file's only use of it.
func unstructuredNestedSlice(obj map[string]any, fields ...string) ([]any, bool, error) {
	var cur any = obj
	for _, f := range fields {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false, nil
		}
		cur, ok = m[f]
		if !ok {
			return nil, false, nil
		}
	}
	s, ok := cur.([]any)
	return s, ok, nil
}

// listCSVs returns OLM ClusterServiceVersion {name, namespace} pairs across
// all namespaces. If the CRD isn't installed, returns an empty slice with no
// error so callers don't paint spurious warnings.
func (d *Detector) listCSVs(ctx context.Context) ([]csvHit, error) {
	gvr := schema.GroupVersionResource{
		Group:    "operators.coreos.com",
		Version:  "v1alpha1",
		Resource: "clusterserviceversions",
	}
	list, err := d.dyn.Resource(gvr).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		// CRD missing on the cluster — common, not an error.
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]csvHit, 0, len(list.Items))
	for _, item := range list.Items {
		out = append(out, csvHit{name: item.GetName(), namespace: item.GetNamespace()})
	}
	return out, nil
}

// matchCSV tries a few common CSV name patterns for a given component.
func matchCSV(comp string, csvs []csvHit) (csvHit, bool) {
	if len(csvs) == 0 {
		return csvHit{}, false
	}
	candidates := []string{
		comp,
		comp + "-operator",
	}
	switch comp {
	case "nvidia-device-plugin":
		candidates = append(candidates, "gpu-operator-certified", "gpu-operator")
	case "kserve":
		candidates = append(candidates, "kserve-operator")
	case "prometheus":
		candidates = append(candidates, "prometheusoperator", "prometheus-operator")
	}
	for _, base := range candidates {
		for _, c := range csvs {
			if strings.HasPrefix(c.name, base+".") || c.name == base {
				return c, true
			}
		}
	}
	return csvHit{}, false
}

// EnsureNamespace creates the system namespace if missing. Helm install does
// this too via CreateNamespace=true, but we precreate so other features (e.g.
// the image registry config) don't race the first install.
func EnsureNamespace(ctx context.Context, typed kubernetes.Interface, name string) error {
	_, err := typed.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	if !apierrors.IsNotFound(err) {
		return err
	}
	_, err = typed.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
			Labels: map[string]string{
				ManagedByLabel: ManagedByLabelValue,
			},
		},
	}, metav1.CreateOptions{})
	return err
}
