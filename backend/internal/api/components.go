package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/components"
)

type componentsAPI struct {
	svc *components.Service
}

func newComponentsAPI(svc *components.Service) *componentsAPI {
	return &componentsAPI{svc: svc}
}

func (a *componentsAPI) routes(r chi.Router) {
	r.Get("/", a.list)
	r.Post("/", a.importChart)
	r.Get("/{name}", a.get)
	r.Get("/{name}/status", a.status)
	r.Patch("/{name}", a.patch)
	r.Delete("/{name}", a.remove)
	r.Post("/{name}/install", a.install)
	r.Post("/{name}/uninstall", a.uninstall)
	r.Post("/{name}/reconcile", a.reconcile)
}

func (a *componentsAPI) list(w http.ResponseWriter, r *http.Request) {
	items, err := a.svc.List(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *componentsAPI) get(w http.ResponseWriter, r *http.Request) {
	c, err := a.svc.Get(r.Context(), chi.URLParam(r, "name"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *componentsAPI) patch(w http.ResponseWriter, r *http.Request) {
	var req components.PatchRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	if req.SelectedVersion == nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "no fields to patch"})
		return
	}
	c, err := a.svc.PatchVersion(r.Context(), chi.URLParam(r, "name"), *req.SelectedVersion)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *componentsAPI) install(w http.ResponseWriter, r *http.Request) {
	c, err := a.svc.Install(r.Context(), chi.URLParam(r, "name"))
	if err != nil {
		writeJSON(w, http.StatusOK, struct {
			components.Component
			Error string `json:"error,omitempty"`
		}{c, err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *componentsAPI) uninstall(w http.ResponseWriter, r *http.Request) {
	c, err := a.svc.Uninstall(r.Context(), chi.URLParam(r, "name"))
	if err != nil {
		writeJSON(w, http.StatusOK, struct {
			components.Component
			Error string `json:"error,omitempty"`
		}{c, err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *componentsAPI) reconcile(w http.ResponseWriter, r *http.Request) {
	c, err := a.svc.Reconcile(r.Context(), chi.URLParam(r, "name"))
	if err != nil {
		writeJSON(w, http.StatusOK, struct {
			components.Component
			Error string `json:"error,omitempty"`
		}{c, err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *componentsAPI) status(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "name query param is required"})
		return
	}
	c, err := a.svc.Status(r.Context(), name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *componentsAPI) importChart(w http.ResponseWriter, r *http.Request) {
	var req components.ImportRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	c, err := a.svc.Import(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (a *componentsAPI) remove(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.Remove(r.Context(), chi.URLParam(r, "name")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
