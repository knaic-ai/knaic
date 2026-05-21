package api

import (
	"net/http"
)

// ClusterInfo is the small payload the frontend reads to label the header
// (cluster name + platform URL). Values come from the KNAIC_CLUSTER_NAME and
// KNAIC_PLATFORM_URL env vars; empty values just render as a placeholder.
type ClusterInfo struct {
	ClusterName string `json:"clusterName"`
	PlatformURL string `json:"platformURL,omitempty"`
}

func newClusterInfoHandler(info ClusterInfo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, info)
	}
}
