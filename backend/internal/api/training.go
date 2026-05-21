package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/training"
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
	// Cancel/Resume map to spec.suspend on the TrainJob — the Trainer v2
	// controller scales every replicated job to zero replicas without
	// deleting the object, so resume is a single-toggle away.
	r.Post("/jobs/{name}/cancel", a.cancelJob)
	r.Post("/jobs/{name}/resume", a.resumeJob)
}

func (a *trainingAPI) suspend(w http.ResponseWriter, r *http.Request, suspended bool) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.SuspendJob(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), suspended)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, obj.Object)
}

func (a *trainingAPI) cancelJob(w http.ResponseWriter, r *http.Request) { a.suspend(w, r, true) }
func (a *trainingAPI) resumeJob(w http.ResponseWriter, r *http.Request) { a.suspend(w, r, false) }

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
