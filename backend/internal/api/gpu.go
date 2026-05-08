package api

import (
	"context"
	"net/http"

	"github.com/alauda/knaic-backend/internal/auth"
	"github.com/alauda/knaic-backend/internal/gpu"
	"github.com/alauda/knaic-backend/internal/monitoring"
)

// gpuAPI mounts the Monitoring → GPU Status endpoints. Cluster-scope reads
// require platform-admin (they list every node + every pod cluster-wide);
// namespace-scope is open to any authenticated user with read on pods in
// that namespace — the apiserver enforces that for the impersonating
// client knaic forwards on.
type gpuAPI struct {
	source     k8sClientSource
	saService  *gpu.Service // backend-SA backed, used for non-impersonated calls (admin)
	monitoring *monitoring.Service
}

func newGPUAPI(source k8sClientSource, saService *gpu.Service, mon *monitoring.Service) *gpuAPI {
	return &gpuAPI{source: source, saService: saService, monitoring: mon}
}

// status routes the request to the SA-backed service for cluster scope
// (admin only), or to an impersonating client for namespace scope.
func (a *gpuAPI) status(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	scope := q.Get("scope")
	if scope == "" {
		scope = "cluster"
	}
	target := q.Get("target")

	var u *auth.User
	if uu, ok := auth.FromContext(r.Context()); ok {
		u = uu
	}
	isAdmin := u != nil && u.IsPlatformAdmin

	opts := gpu.Options{Scope: scope, Namespace: target, IsAdmin: isAdmin}
	svc, err := a.serviceFor(r, isAdmin)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out, err := svc.Status(r.Context(), opts)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// serviceFor picks between the platform-SA service (admin, cluster-wide
// reads) and a per-request impersonating service (namespace-scoped reads
// where K8s RBAC drives visibility).
func (a *gpuAPI) serviceFor(r *http.Request, isAdmin bool) (*gpu.Service, error) {
	if isAdmin && a.saService != nil {
		return a.saService, nil
	}
	clients, err := a.source.clientsForRequest(r)
	if err != nil {
		return nil, err
	}
	return gpu.New(clients.Typed), nil
}

// deviceUsage proxies a DCGM-style PromQL range query so the page can
// render a per-card usage chart for each physical GPU. Admin-only —
// cluster-wide metrics. Returns the raw monitoring Series payload; the
// frontend slices it by node + GPU index.
func (a *gpuAPI) deviceUsage(w http.ResponseWriter, r *http.Request) {
	if a.monitoring == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	out, err := a.monitoring.RawDeviceUsage(r.Context(), monitoring.DeviceUsageRequest{
		Start: parseUnixTime(r, "start"),
		End:   parseUnixTime(r, "end"),
		Step:  parseStepSeconds(r, "step"),
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// parseUnixTime / parseStepSeconds are tiny helpers; keeping them here so
// the GPU handler is self-contained.
func parseUnixTime(r *http.Request, key string) int64 {
	v := r.URL.Query().Get(key)
	if v == "" {
		return 0
	}
	return parseInt64Default(v, 0)
}

func parseStepSeconds(r *http.Request, key string) int64 {
	v := r.URL.Query().Get(key)
	if v == "" {
		return 0
	}
	return parseInt64Default(v, 0)
}

// parseInt64Default — parse an int64 from a string, return def on error.
// Inlined to avoid yet another util file.
func parseInt64Default(s string, def int64) int64 {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int64(c-'0')
	}
	return n
}

// no-op consumer to keep ctx usage explicit if we need it later.
var _ = context.Background
