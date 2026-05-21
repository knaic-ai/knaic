package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/collections"
)

type collectionsAPI struct {
	svc *collections.Service
}

func newCollectionsAPI(svc *collections.Service) *collectionsAPI {
	return &collectionsAPI{svc: svc}
}

func (a *collectionsAPI) routes(r chi.Router) {
	r.Get("/", a.list)
	r.Post("/", a.create)
	r.Get("/{id}", a.get)
	r.Patch("/{id}", a.patch)
	r.Delete("/{id}", a.delete)
}

func (a *collectionsAPI) list(w http.ResponseWriter, r *http.Request) {
	scope := collections.Scope(r.URL.Query().Get("scope"))
	if scope == "" {
		scope = collections.ScopePublic
	}
	ns := r.URL.Query().Get("namespace")
	items, err := a.svc.List(r.Context(), scope, ns)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	if items == nil {
		items = []collections.Collection{}
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *collectionsAPI) get(w http.ResponseWriter, r *http.Request) {
	c, err := a.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeCollectionsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *collectionsAPI) create(w http.ResponseWriter, r *http.Request) {
	var req collections.CreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	c, err := a.svc.Create(r.Context(), u, req)
	if err != nil {
		writeCollectionsError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (a *collectionsAPI) patch(w http.ResponseWriter, r *http.Request) {
	var req collections.PatchRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	c, err := a.svc.Patch(r.Context(), u, chi.URLParam(r, "id"), req)
	if err != nil {
		writeCollectionsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *collectionsAPI) delete(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	if err := a.svc.Delete(r.Context(), u, chi.URLParam(r, "id")); err != nil {
		writeCollectionsError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeCollectionsError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, collections.ErrNotFound):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	case errors.Is(err, collections.ErrConflict):
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
	case errors.Is(err, collections.ErrForbidden):
		writeJSON(w, http.StatusForbidden, apiError{Error: err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	}
}
