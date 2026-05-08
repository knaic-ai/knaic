package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/inference"
	"github.com/alauda/knaic-backend/internal/k8sres"
)

type inferenceAPI struct {
	svc    *inference.Service
	source k8sClientSource
}

func newInferenceAPI(svc *inference.Service, source k8sClientSource) *inferenceAPI {
	return &inferenceAPI{svc: svc, source: source}
}

func (a *inferenceAPI) routes(r chi.Router) {
	r.Post("/services", a.createService)
	r.Put("/services/{name}", a.updateService)
	r.Post("/runtimes", a.createRuntime)
	r.Put("/runtimes/{name}", a.updateRuntime)
	r.Get("/services/{name}/logs", a.logs)
	r.Get("/services/{name}/pods", a.pods)
	r.Post("/services/{name}/stop", a.stop)
	r.Post("/services/{name}/start", a.start)
}

// pods lists all pods backing an InferenceService / LLMInferenceService —
// the log viewer's pod picker uses this so users can read logs from old
// replicas during a rolling update or from init containers that have
// completed.
func (a *inferenceAPI) pods(w http.ResponseWriter, r *http.Request) {
	svc, err := a.logService(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	pods, err := svc.ListInferencePods(
		r.Context(),
		chi.URLParam(r, "namespace"),
		chi.URLParam(r, "name"),
		r.URL.Query().Get("kind"),
	)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pods)
}

// LLMConfigsHandler is a top-level (non-namespaced) endpoint that lists
// LLMInferenceServiceConfig refs cluster-wide for the form's "Base config"
// picker. Returned object: [{name, namespace}].
func (a *inferenceAPI) LLMConfigsHandler(w http.ResponseWriter, r *http.Request) {
	configs, err := a.svc.ListLLMConfigs(r.Context())
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, configs)
}

// DeploymentModesHandler returns the deploymentMode values the cluster's
// KServe install can handle, plus the configured default. Used by the
// InferenceService form's "Deployment mode" picker.
func (a *inferenceAPI) DeploymentModesHandler(w http.ResponseWriter, r *http.Request) {
	info, err := a.svc.ListDeploymentModes(r.Context())
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (a *inferenceAPI) updateRuntime(w http.ResponseWriter, r *http.Request) {
	var req inference.CreateRuntimeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.UpdateRuntime(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, obj.Object)
}

func (a *inferenceAPI) updateService(w http.ResponseWriter, r *http.Request) {
	var req inference.CreateServiceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.UpdateService(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), req)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, obj.Object)
}

func (a *inferenceAPI) logs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	opts := k8sres.LogOptions{
		Container: q.Get("container"),
		Follow:    q.Get("follow") == "true",
		Previous:  q.Get("previous") == "true",
	}
	if v, err := strconv.ParseInt(q.Get("tailLines"), 10, 64); err == nil && v > 0 {
		opts.TailLines = v
	}
	if v, err := strconv.ParseInt(q.Get("sinceSeconds"), 10, 64); err == nil && v > 0 {
		opts.SinceSeconds = v
	}
	svc, err := a.logService(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	err = svc.StreamInferenceServiceLogs(
		r.Context(),
		w,
		chi.URLParam(r, "namespace"),
		chi.URLParam(r, "name"),
		q.Get("kind"),
		opts,
	)
	if err != nil && !errors.Is(err, http.ErrAbortHandler) {
		writeK8sError(w, err)
	}
}

func (a *inferenceAPI) toggleStopped(w http.ResponseWriter, r *http.Request, stopped bool) {
	kind := r.URL.Query().Get("kind")
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.SetStopped(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), kind, stopped)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, obj.Object)
}

func (a *inferenceAPI) stop(w http.ResponseWriter, r *http.Request)  { a.toggleStopped(w, r, true) }
func (a *inferenceAPI) start(w http.ResponseWriter, r *http.Request) { a.toggleStopped(w, r, false) }

func (a *inferenceAPI) createService(w http.ResponseWriter, r *http.Request) {
	var req inference.CreateServiceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	obj, err := svc.CreateService(r.Context(), chi.URLParam(r, "namespace"), req)
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

func (a *inferenceAPI) service(r *http.Request) (*inference.Service, error) {
	if a.source.authDisabled {
		return a.svc, nil
	}
	clients, err := a.source.clientsForRequest(r)
	if err != nil {
		return nil, err
	}
	return inference.New(clients.Typed, clients.Dynamic, clients.Discovery), nil
}

func (a *inferenceAPI) logService(r *http.Request) (*k8sres.Service, error) {
	clients, err := a.source.clientsForRequest(r)
	if err != nil {
		return nil, err
	}
	return k8sres.NewService(clients.Dynamic, clients.Typed), nil
}
