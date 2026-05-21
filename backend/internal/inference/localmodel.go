package inference

import (
	"context"
	"sort"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// localModelAgentNamespace and localModelAgentName identify the per-node
// agent DaemonSet that KServe's local model cache subsystem ships. We probe
// this DaemonSet to gate the console page — without the agent, the
// LocalModelCache and LocalModelNodeGroup CRs do nothing useful.
const (
	localModelAgentNamespace = "kserve"
	localModelAgentName      = "kserve-localmodelnode-agent"
)

// LocalModelStatus is the response of GET /api/v1/inference/localmodel/status.
// hostPath is the on-node directory the agent stores cached blobs under. It
// MUST equal LocalModelNodeGroup.spec.persistentVolumeSpec.local.path, or
// KServe re-downloads models on every InferenceService start. The frontend
// pre-fills the NodeGroup form's localPath from this value.
type LocalModelStatus struct {
	Installed bool   `json:"installed"`
	HostPath  string `json:"hostPath,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name,omitempty"`
}

// LocalModelCacheStatus probes for the agent DaemonSet and extracts the
// `models` hostPath from its volume list. Returns Installed=false (and no
// error) when the DaemonSet is absent, so the UI can render an empty state
// without surfacing a misleading "internal error".
func (s *Service) LocalModelCacheStatus(ctx context.Context) (LocalModelStatus, error) {
	if s.typed == nil {
		return LocalModelStatus{}, nil
	}
	ds, err := s.typed.AppsV1().DaemonSets(localModelAgentNamespace).Get(ctx, localModelAgentName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return LocalModelStatus{Installed: false}, nil
	}
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
		// Non-admin RBAC won't grant `get daemonsets` cluster-wide. Treat
		// this as "we can't tell" — surface installed=false so the page
		// degrades to read-only listing rather than 500ing.
		return LocalModelStatus{Installed: false}, nil
	}
	if err != nil {
		return LocalModelStatus{}, err
	}
	hostPath := ""
	for _, v := range ds.Spec.Template.Spec.Volumes {
		if v.Name == "models" && v.HostPath != nil {
			hostPath = v.HostPath.Path
			break
		}
	}
	return LocalModelStatus{
		Installed: true,
		HostPath:  hostPath,
		Namespace: localModelAgentNamespace,
		Name:      localModelAgentName,
	}, nil
}

// LocalModelOptions feeds the NodeGroup form's "Node selector key" and
// "Storage class" pickers. Node label keys are aggregated across the cluster
// (the same label often varies in value per node, but the key set is small)
// so admins can pick from a list rather than typing exact strings. Storage
// classes are the unfiltered list — `local-storage` is the recommended
// default because KServe's agent writes blobs to a node-local hostPath, so a
// pure local PV is the only StorageClass that won't dynamically provision
// somewhere else.
type LocalModelOptions struct {
	NodeLabelKeys  []string `json:"nodeLabelKeys"`
	StorageClasses []string `json:"storageClasses"`
}

func (s *Service) LocalModelOptions(ctx context.Context) (LocalModelOptions, error) {
	out := LocalModelOptions{NodeLabelKeys: []string{}, StorageClasses: []string{}}
	if s.typed == nil {
		return out, nil
	}

	nodes, err := s.typed.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	switch {
	case apierrors.IsForbidden(err), apierrors.IsUnauthorized(err):
		// non-admin: leave node keys empty, fall through to storage classes.
	case err != nil:
		return out, err
	default:
		keys := map[string]struct{}{}
		for i := range nodes.Items {
			for k := range nodes.Items[i].Labels {
				keys[k] = struct{}{}
			}
		}
		out.NodeLabelKeys = make([]string, 0, len(keys))
		for k := range keys {
			out.NodeLabelKeys = append(out.NodeLabelKeys, k)
		}
		sort.Strings(out.NodeLabelKeys)
	}

	scs, err := s.typed.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	switch {
	case apierrors.IsForbidden(err), apierrors.IsUnauthorized(err):
		// non-admin without storage-class read: empty list, UI falls back to free-text.
	case err != nil:
		return out, err
	default:
		out.StorageClasses = make([]string, 0, len(scs.Items))
		for i := range scs.Items {
			out.StorageClasses = append(out.StorageClasses, scs.Items[i].Name)
		}
		sort.Strings(out.StorageClasses)
	}
	return out, nil
}
