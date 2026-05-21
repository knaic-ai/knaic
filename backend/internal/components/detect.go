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

// Detector resolves the live install state of a single component.
//
// Priority (first match wins):
//   1. OLM ClusterServiceVersion              -> Installed / OLM
//   2. knaic-owned Helm release (label match) -> Installed / knaic
//   3. any other Helm release of the chart    -> Installed / manual
//   4. none of the above                      -> NotInstalled
//
// Each match attempt consults the component's Name and every entry in
// Aliases — that lets knaic recognise a component whose canonical name
// diverges from the upstream chart's.
//
// All listings (Helm, OLM CSV) are taken once per snapshotTTL window and
// cached so N parallel per-component requests share one cluster scan.
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

type clusterSnapshot struct {
	releasesByChart map[string][]helmReleaseHit
	csvs            []csvHit
	helmErr         error
	csvErr          error
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

	// Names to probe each index with. The component's own Name takes
	// precedence (preserves install history); aliases catch upstream-named
	// artefacts that don't match the canonical knaic identity.
	probe := componentProbeNames(c)

	// 1. OLM CSV — strongest signal of operator-managed lifecycle.
	for _, n := range probe {
		if csv, ok := matchCSV(n, snap.csvs); ok {
			return store.Update(name, func(item *Component) {
				item.Status = StatusInstalled
				item.Namespace = csv.namespace
				item.ManagedBy = ManagedByOLM
				item.Notes = fmt.Sprintf("Detected via OLM ClusterServiceVersion %q in %q.", csv.name, csv.namespace)
			})
		}
	}
	// 2. knaic-owned Helm release — explicit label match.
	for _, n := range probe {
		for _, h := range snap.releasesByChart[n] {
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
	// 3. Other Helm release of the same chart (not installed by knaic).
	for _, n := range probe {
		if hits := snap.releasesByChart[n]; len(hits) > 0 {
			chosen := hits[0]
			return store.Update(name, func(item *Component) {
				item.Status = StatusInstalled
				item.Namespace = chosen.namespace
				item.ManagedBy = chosen.owner
				item.Notes = fmt.Sprintf("Helm release %q in %q (not installed by knaic).", chosen.name, chosen.namespace)
			})
		}
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

// componentProbeNames returns the names to probe each detection index
// with — the component's own Name followed by any declared Aliases, with
// blanks and duplicates removed. Name always comes first so an exact
// canonical match wins over an alias-driven one.
func componentProbeNames(c Component) []string {
	out := make([]string, 0, 1+len(c.Aliases))
	seen := map[string]bool{}
	push := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}
	push(c.Name)
	for _, a := range c.Aliases {
		push(a)
	}
	return out
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
