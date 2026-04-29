package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/inference"
)

type inferenceAPI struct {
	svc *inference.Service
}

func newInferenceAPI(svc *inference.Service) *inferenceAPI {
	return &inferenceAPI{svc: svc}
}

func (a *inferenceAPI) routes(r chi.Router) {
	r.Post("/services", a.createService)
	r.Post("/runtimes", a.createRuntime)
}

func (a *inferenceAPI) createService(w http.ResponseWriter, r *http.Request) {
	var req inference.CreateServiceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	obj, err := a.svc.CreateService(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, obj.Object)
}

func (a *inferenceAPI) createRuntime(w http.ResponseWriter, r *http.Request) {
	var req inference.CreateRuntimeRequest
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
