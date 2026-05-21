package api

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/gpu"
	"github.com/knaic/knaic-backend/internal/monitoring"
)

// gpuAPI mounts the Monitoring → GPU Status endpoints.
//
//   - Cluster-scope, platform admin: SA-backed apiserver reads (every node
//     + every pod cluster-wide, no per-user RBAC dependency).
//   - Cluster-scope, non-admin: VictoriaMetrics-backed read of
//     kube-state-metrics + node capacity. Non-admins can't list nodes
//     cluster-wide via impersonation, so the apiserver path returns
//     nothing; the monitoring path exposes the same numbers without
//     leaking apiserver privileges.
//   - Namespace-scope (any caller): apiserver via the impersonating client
//     — Kubernetes RBAC enforces what the user can read.
type gpuAPI struct {
	source     k8sClientSource
	saService  *gpu.Service           // backend-SA backed, admin cluster reads
	monGPU     *gpu.MonitoringService // VM-backed, non-admin cluster reads
	monitoring *monitoring.Service
	profiles   *gpu.ProfileStore
}

func newGPUAPI(source k8sClientSource, saService *gpu.Service, mon *monitoring.Service, profiles *gpu.ProfileStore) *gpuAPI {
	return &gpuAPI{
		source:     source,
		saService:  saService,
		monGPU:     gpu.NewMonitoringService(mon),
		monitoring: mon,
		profiles:   profiles,
	}
}

// listProfiles returns the cluster's GPU profile catalog. Open to any
// authenticated user (the picker on every workload-creation form reads
// from here).
func (a *gpuAPI) listProfiles(w http.ResponseWriter, r *http.Request) {
	if a.profiles == nil {
		writeJSON(w, http.StatusOK, []gpu.Profile{})
		return
	}
	profiles, err := a.profiles.List(r.Context())
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, profiles)
}

// createProfile / updateProfile / deleteProfile are admin-only — gated by
// auth.RequirePlatformAdmin in the router.
func (a *gpuAPI) createProfile(w http.ResponseWriter, r *http.Request) {
	if a.profiles == nil {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "gpu profile store unavailable"})
		return
	}
	var p gpu.Profile
	if err := decodeJSON(r, &p); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	out, err := a.profiles.Create(r.Context(), p)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (a *gpuAPI) updateProfile(w http.ResponseWriter, r *http.Request) {
	if a.profiles == nil {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "gpu profile store unavailable"})
		return
	}
	var p gpu.Profile
	if err := decodeJSON(r, &p); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	// The id in the URL wins — body id is overwritten so a mismatch can't
	// rewrite a different profile.
	p.ID = chi.URLParam(r, "id")
	out, err := a.profiles.Update(r.Context(), p)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *gpuAPI) deleteProfile(w http.ResponseWriter, r *http.Request) {
	if a.profiles == nil {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "gpu profile store unavailable"})
		return
	}
	if err := a.profiles.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// status routes the request to the appropriate data source. See gpuAPI's
// doc-comment for the matrix; in short: admins → apiserver via the SA;
// non-admin cluster-scope → VictoriaMetrics; namespace-scope → apiserver
// via impersonation.
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

	// Non-admin + cluster scope is only feasible via monitoring: the
	// impersonating client can't list nodes / pods cluster-wide.
	if scope == "cluster" && !isAdmin && a.monGPU.Available() {
		out, err := a.monGPU.Status(r.Context(), opts)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

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
