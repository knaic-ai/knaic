package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/training"
)

type trainingAPI struct {
	svc *training.Service
}

func newTrainingAPI(svc *training.Service) *trainingAPI {
	return &trainingAPI{svc: svc}
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
	obj, err := a.svc.CreateRuntime(r.Context(), chi.URLParam(r, "namespace"), req)
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
	obj, err := a.svc.CreateJob(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, obj.Object)
}

func (a *trainingAPI) mlflow(w http.ResponseWriter, r *http.Request) {
	run, err := a.svc.MLflowRun(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}
