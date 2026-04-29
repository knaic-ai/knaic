package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/notebook"
)

type notebookAPI struct {
	svc *notebook.Service
}

func newNotebookAPI(svc *notebook.Service) *notebookAPI {
	return &notebookAPI{svc: svc}
}

func (a *notebookAPI) routes(r chi.Router) {
	r.Post("/", a.create)
	r.Post("/{name}/stop", a.stop)
	r.Post("/{name}/start", a.start)
}

func (a *notebookAPI) create(w http.ResponseWriter, r *http.Request) {
	var req notebook.CreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	obj, err := a.svc.Create(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, obj.Object)
}

func (a *notebookAPI) stop(w http.ResponseWriter, r *http.Request) {
	obj, err := a.svc.Stop(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, obj.Object)
}

func (a *notebookAPI) start(w http.ResponseWriter, r *http.Request) {
	obj, err := a.svc.Start(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, obj.Object)
}
