// Package aistorage backs the "AI Storage" feature: per-namespace S3 object
// stores, PVC file management (via a per-PVC filebrowser Deployment), and
// GitLab repository browsing with git-LFS support.
//
// The package owns three concerns:
//
//   - S3: it stores credentials as KServe-compatible Secrets (see
//     https://kserve.github.io/website/docs/model-serving/storage/providers/s3)
//     and proxies object listing / upload / download through the backend so
//     the browser never holds AWS keys and so we don't have to manage bucket
//     CORS.
//
//   - PVC: it spawns a filebrowser/filebrowser Deployment + Service per PVC
//     on demand. The backend reverse-proxies /aistorage/pvc/{pvc}/viewer/*
//     to the per-PVC Service so the UI embeds the viewer in an iframe
//     without any extra Ingress wiring.
//
//   - GitLab: it stores a Secret with the GitLab base URL + a personal
//     access token, then proxies file listing / upload / download through
//     the backend using GitLab's REST API. Files larger than the
//     configured threshold (or explicitly marked as LFS) are uploaded via
//     the git-LFS batch protocol and surfaced with an "LFS" badge in the UI.
//
// All write paths are gated by `auth.RequirePlatformAdmin` at the HTTP
// layer (see internal/api/aistorage.go) for the admin secret-management
// endpoints; the file-ops endpoints respect whatever RBAC the calling user
// has on the namespace via apiserver impersonation.
package aistorage

import (
	"k8s.io/client-go/kubernetes"
)

// Service is the entrypoint to all AI Storage operations. It is constructed
// once per request from the caller's impersonated kubernetes.Interface so
// every Secret/Deployment/PVC read/write respects the user's RBAC.
type Service struct {
	typed kubernetes.Interface
}

// New returns a Service bound to the given typed Kubernetes client.
func New(typed kubernetes.Interface) *Service {
	return &Service{typed: typed}
}

// Common label/annotation keys used to mark resources we own.
const (
	// labelManaged + labelComponent let admins find AI-Storage-managed
	// secrets/deployments with one selector (knaic.io/component=aistorage).
	labelManaged   = "knaic.io/managed"
	labelComponent = "knaic.io/component"
	labelKind      = "knaic.io/aistorage-kind"   // "s3" | "gitlab"
	labelPVC       = "knaic.io/aistorage-pvc"    // PVC name for viewer Deployments
	labelEndpoint  = "knaic.io/aistorage-endpoint"

	componentValue = "aistorage"
)
