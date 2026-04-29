package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/auth"
	"github.com/alauda/knaic-backend/internal/models"
)

type modelsAPI struct {
	svc *models.Service
}

func newModelsAPI(svc *models.Service) *modelsAPI {
	return &modelsAPI{svc: svc}
}

func (a *modelsAPI) routes(r chi.Router) {
	r.Get("/", a.list)
	r.Post("/", a.create)
	r.Post("/import", a.importURL)
	r.Post("/upload", a.upload)
	r.Get("/{id}", a.get)
	r.Patch("/{id}", a.patch)
	r.Delete("/{id}", a.delete)
}

func (a *modelsAPI) list(w http.ResponseWriter, r *http.Request) {
	scope := models.Scope(r.URL.Query().Get("scope"))
	if scope == "" {
		scope = models.ScopePublic
	}
	ns := r.URL.Query().Get("namespace")
	items, err := a.svc.List(r.Context(), scope, ns)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *modelsAPI) get(w http.ResponseWriter, r *http.Request) {
	m, err := a.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (a *modelsAPI) create(w http.ResponseWriter, r *http.Request) {
	var req models.CreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	m, err := a.svc.Create(r.Context(), u, req)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (a *modelsAPI) importURL(w http.ResponseWriter, r *http.Request) {
	var req models.ImportRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	m, err := a.svc.Import(r.Context(), u, req)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (a *modelsAPI) upload(w http.ResponseWriter, r *http.Request) {
	var req models.UploadRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	m, err := a.svc.Upload(r.Context(), u, req)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (a *modelsAPI) patch(w http.ResponseWriter, r *http.Request) {
	var req models.PatchRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	m, err := a.svc.Patch(r.Context(), u, chi.URLParam(r, "id"), req)
	if err != nil {
		writeModelsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (a *modelsAPI) delete(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	if err := a.svc.Delete(r.Context(), u, chi.URLParam(r, "id")); err != nil {
		writeModelsError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeModelsError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, models.ErrNotFound):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	case errors.Is(err, models.ErrConflict):
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
	case errors.Is(err, models.ErrForbidden):
		writeJSON(w, http.StatusForbidden, apiError{Error: err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	}
}
