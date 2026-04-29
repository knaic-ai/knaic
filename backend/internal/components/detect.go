package components

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

// Detector reconciles the in-memory component store with real cluster state:
//   - releases knaic owns -> Installed
//   - releases of the same chart owned by something else -> Unmanaged (manual)
//   - operator-installed workloads (CSV present) -> Unmanaged (OLM)
//   - everything else -> NotInstalled
type Detector struct {
	helm  HelmClient
	typed kubernetes.Interface
	dyn   dynamic.Interface
}

func NewDetector(helm HelmClient, typed kubernetes.Interface, dyn dynamic.Interface) *Detector {
	return &Detector{helm: helm, typed: typed, dyn: dyn}
}

// Reconcile walks every component in the store and updates Status / ManagedBy
// based on what's currently in the cluster. It is safe to call repeatedly.
func (d *Detector) Reconcile(ctx context.Context, store *Store) error {
	releases, err := d.helm.ListAll(ctx)
	if err != nil {
		return fmt.Errorf("list helm releases: %w", err)
	}

	// Index releases by chart name for fast lookup.
	byChart := map[string][]string{}    // chartName -> []releaseName
	knaicByChart := map[string]string{} // chartName -> our release name
	for _, rel := range releases {
		if rel == nil || rel.Chart == nil || rel.Chart.Metadata == nil {
			continue
		}
		ch := rel.Chart.Metadata.Name
		byChart[ch] = append(byChart[ch], rel.Name)
		if IsKnaicRelease(rel) {
			knaicByChart[ch] = rel.Name
		}
	}

	csvByName, csvErr := d.listCSVs(ctx)
	if csvErr != nil {
		// OLM CRDs may not be installed; that's fine, treat as none.
		csvByName = nil
	}

	for _, c := range store.List() {
		c := c
		store.Update(c.Name, func(item *Component) {
			switch {
			case knaicByChart[c.Name] != "":
				item.Status = StatusInstalled
				item.ManagedBy = ManagedByKnaic
				item.Notes = ""
			case len(byChart[c.Name]) > 0:
				item.Status = StatusUnmanaged
				item.ManagedBy = ManagedByManual
				item.Notes = "Helm release exists but was not installed by knaic."
			case d.olmManages(c.Name, csvByName):
				item.Status = StatusUnmanaged
				item.ManagedBy = ManagedByOLM
				item.Notes = "Detected at runtime — installed via OLM ClusterServiceVersion."
			case d.deploymentExists(ctx, c):
				item.Status = StatusUnmanaged
				item.ManagedBy = ManagedByManual
				item.Notes = "A Deployment matching this component exists in the cluster."
			default:
				if item.Status == StatusUnmanaged || item.Status == StatusInstalled {
					item.Status = StatusNotInstalled
					item.ManagedBy = ""
					item.Notes = ""
				}
			}
		})
	}
	return nil
}

// listCSVs returns OLM ClusterServiceVersion names across all namespaces.
// If the CRD isn't installed, returns an error the caller can ignore.
func (d *Detector) listCSVs(ctx context.Context) (map[string]struct{}, error) {
	gvr := schema.GroupVersionResource{
		Group:    "operators.coreos.com",
		Version:  "v1alpha1",
		Resource: "clusterserviceversions",
	}
	list, err := d.dyn.Resource(gvr).Namespace(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make(map[string]struct{}, len(list.Items))
	for _, item := range list.Items {
		out[item.GetName()] = struct{}{}
	}
	return out, nil
}

// olmManages tries a few common CSV name patterns for each builtin component.
func (d *Detector) olmManages(comp string, csvs map[string]struct{}) bool {
	if csvs == nil {
		return false
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
		for name := range csvs {
			if strings.HasPrefix(name, base+".") || name == base {
				return true
			}
		}
	}
	return false
}

func (d *Detector) deploymentExists(ctx context.Context, c Component) bool {
	// We check the configured install namespace plus a few known fallbacks.
	candidates := []string{c.Namespace, "kserve", "kubeflow", "kube-system"}
	seen := map[string]struct{}{}
	for _, ns := range candidates {
		if ns == "" {
			continue
		}
		if _, dup := seen[ns]; dup {
			continue
		}
		seen[ns] = struct{}{}
		opts := metav1.ListOptions{
			LabelSelector: ComponentLabel + "=" + c.Name,
			Limit:         1,
		}
		dl, err := d.typed.AppsV1().Deployments(ns).List(ctx, opts)
		if err != nil {
			if apierrors.IsNotFound(err) || apierrors.IsForbidden(err) {
				continue
			}
			continue
		}
		if len(dl.Items) > 0 {
			return true
		}
		// Fallback: by inferred name.
		if dep, err := d.typed.AppsV1().Deployments(ns).Get(ctx, c.Name+"-controller", metav1.GetOptions{}); err == nil && dep != nil {
			return true
		}
	}
	return false
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
