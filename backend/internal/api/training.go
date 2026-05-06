package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/training"
)

type trainingAPI struct {
	svc    *training.Service
	source k8sClientSource
}

func newTrainingAPI(svc *training.Service, source k8sClientSource) *trainingAPI {
	return &trainingAPI{svc: svc, source: source}
}

func (a *trainingAPI) routes(r chi.Router) {
	r.Post("/runtimes", a.createRuntime)
	r.Post("/jobs", a.createJob)
	r.Get("/jobs/{name}/mlflow", a.mlflow)
}

func (a *trainingAPI) createRuntime(w http.ResponseWriter, r *http.Request) {
	var req training.CreateRuntimeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.CreateRuntime(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, obj.Object)
}

func (a *trainingAPI) createJob(w http.ResponseWriter, r *http.Request) {
	var req training.CreateJobRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.CreateJob(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, obj.Object)
}

func (a *trainingAPI) mlflow(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	run, err := svc.MLflowRun(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (a *trainingAPI) service(r *http.Request) (*training.Service, error) {
	if a.source.authDisabled {
		return a.svc, nil
	}
	clients, err := a.source.clientsForRequest(r)
	if err != nil {
		return nil, err
	}
	return a.svc.WithDynamic(clients.Dynamic), nil
}
