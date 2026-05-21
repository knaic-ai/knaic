package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/notebook"
)

type notebookAPI struct {
	svc    *notebook.Service
	source k8sClientSource
}

func newNotebookAPI(svc *notebook.Service, source k8sClientSource) *notebookAPI {
	return &notebookAPI{svc: svc, source: source}
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
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.Create(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, obj.Object)
}

func (a *notebookAPI) stop(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.Stop(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, obj.Object)
}

func (a *notebookAPI) start(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.Start(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, obj.Object)
}

func (a *notebookAPI) service(r *http.Request) (*notebook.Service, error) {
	if a.source.authDisabled {
		return a.svc, nil
	}
	clients, err := a.source.clientsForRequest(r)
	if err != nil {
		return nil, err
	}
	return notebook.New(clients.Dynamic, clients.Typed), nil
}
