package api

import (
	"context"
	"net/http"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// ClusterInfo is the small payload the frontend reads to label the header
// (cluster name + platform URL). Sourced from the cpaas convention of a
// `global-info` ConfigMap in the `kube-public` namespace, which is
// world-readable by every authenticated user.
type ClusterInfo struct {
	ClusterName string `json:"clusterName"`
	PlatformURL string `json:"platformURL,omitempty"`
}

// clusterInfoNamespace and clusterInfoConfigMap are where cpaas stores the
// public cluster identity. Hardcoded here because it's a fixed convention
// of the platform — make this configurable if knaic ever runs on a non-cpaas
// distribution that names the configmap differently.
const (
	clusterInfoNamespace = "kube-public"
	clusterInfoConfigMap = "global-info"
)

func newClusterInfoHandler(typed kubernetes.Interface) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, readClusterInfo(r.Context(), typed))
	}
}

func readClusterInfo(ctx context.Context, typed kubernetes.Interface) ClusterInfo {
	if typed == nil {
		return ClusterInfo{}
	}
	cm, err := typed.CoreV1().ConfigMaps(clusterInfoNamespace).Get(ctx, clusterInfoConfigMap, metav1.GetOptions{})
	if err != nil {
		// Fail-soft — the header just shows a placeholder when the cluster
		// doesn't follow the cpaas convention. Don't 500 the page over it.
		return ClusterInfo{}
	}
	return ClusterInfo{
		ClusterName: cm.Data["clusterName"],
		PlatformURL: cm.Data["platformURL"],
	}
}
