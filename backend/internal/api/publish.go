package api

import (
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/publish"
)

type publishAPI struct {
	svc *publish.Service
}

func newPublishAPI(svc *publish.Service) *publishAPI { return &publishAPI{svc: svc} }

func (a *publishAPI) routes(r chi.Router) {
	r.Get("/", a.list)
	r.Post("/", a.create)
	r.Get("/{id}", a.get)
	r.Post("/{id}/approve", a.approve)
	r.Post("/{id}/reject", a.reject)
	r.Delete("/{id}", a.delete)
}

func (a *publishAPI) list(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	f := publish.ListFilter{
		Status:    publish.Status(r.URL.Query().Get("status")),
		Namespace: r.URL.Query().Get("namespace"),
	}
	items, err := a.svc.List(r.Context(), u, f)
	if err != nil {
		writePublishError(w, err)
		return
	}
	if items == nil {
		items = []publish.Request{}
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *publishAPI) get(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	id := chi.URLParam(r, "id")
	// Reuse List by id-filter isn't worth it; use the store-level Get via
	// approve/reject path? Simpler: expose a Get on the service or just
	// list+filter here. We'll do a single-item lookup by listing without
	// status filter and matching. For now, the UI only needs list + actions.
	items, err := a.svc.List(r.Context(), u, publish.ListFilter{})
	if err != nil {
		writePublishError(w, err)
		return
	}
	for _, it := range items {
		if it.ID == id {
			writeJSON(w, http.StatusOK, it)
			return
		}
	}
	writeJSON(w, http.StatusNotFound, apiError{Error: "not found"})
}

func (a *publishAPI) create(w http.ResponseWriter, r *http.Request) {
	var req publish.CreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	out, err := a.svc.Create(r.Context(), u, req)
	if err != nil {
		writePublishError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (a *publishAPI) approve(w http.ResponseWriter, r *http.Request) {
	var body publish.ReviewRequest
	if err := decodeJSON(r, &body); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	out, err := a.svc.Approve(r.Context(), u, chi.URLParam(r, "id"), body)
	if err != nil {
		writePublishError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *publishAPI) reject(w http.ResponseWriter, r *http.Request) {
	var body publish.ReviewRequest
	if err := decodeJSON(r, &body); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	out, err := a.svc.Reject(r.Context(), u, chi.URLParam(r, "id"), body)
	if err != nil {
		writePublishError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *publishAPI) delete(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	if err := a.svc.Delete(r.Context(), u, chi.URLParam(r, "id")); err != nil {
		writePublishError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writePublishError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, publish.ErrNotFound):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	case errors.Is(err, publish.ErrConflict):
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
	case errors.Is(err, publish.ErrForbidden):
		writeJSON(w, http.StatusForbidden, apiError{Error: err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	}
}
