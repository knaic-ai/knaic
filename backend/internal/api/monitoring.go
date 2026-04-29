package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/auth"
	"github.com/alauda/knaic-backend/internal/monitoring"
)

type monitoringAPI struct {
	svc *monitoring.Service
}

func newMonitoringAPI(svc *monitoring.Service) *monitoringAPI {
	return &monitoringAPI{svc: svc}
}

func (a *monitoringAPI) routes(r chi.Router) {
	r.Get("/monitoring/query", a.query)
}

func (a *monitoringAPI) query(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	req := monitoring.QueryRequest{
		Scope:    monitoring.Scope(q.Get("scope")),
		Target:   q.Get("target"),
		Resource: monitoring.Resource(q.Get("resource")),
		Kind:     monitoring.Kind(q.Get("kind")),
	}
	if req.Scope == "" {
		req.Scope = monitoring.ScopeCluster
	}
	if req.Resource == "" {
		req.Resource = monitoring.ResourceCPU
	}
	if req.Kind == "" {
		req.Kind = monitoring.KindUsage
	}
	if req.Scope == monitoring.ScopeNode {
		u := auth.MustFromContext(r.Context())
		if !u.IsPlatformAdmin {
			writeJSON(w, http.StatusForbidden, apiError{Error: "platform admin required for node monitoring"})
			return
		}
	}
	if v := q.Get("start"); v != "" {
		if unix, err := strconv.ParseInt(v, 10, 64); err == nil {
			req.Start = time.Unix(unix, 0)
		}
	}
	if v := q.Get("end"); v != "" {
		if unix, err := strconv.ParseInt(v, 10, 64); err == nil {
			req.End = time.Unix(unix, 0)
		}
	}
	if v := q.Get("step"); v != "" {
		if seconds, err := strconv.ParseInt(v, 10, 64); err == nil && seconds > 0 {
			req.Step = time.Duration(seconds) * time.Second
		}
	}
	series, err := a.svc.QueryRange(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, series)
}
