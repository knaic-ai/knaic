package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/inference"
	"github.com/knaic/knaic-backend/internal/k8sres"
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
	// Gateway plumbing — read the route+rate-limit picture for one service,
	// and (admin/editor) provision an AIGatewayRoute + AIServiceBackend + a
	// BackendTrafficPolicy in one call.
	r.Get("/services/{name}/route-status", a.routeStatus)
	r.Post("/services/{name}/gateway-route", a.createGatewayRoute)
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

// GatewayConfigHandler returns the KServe gateway-related configuration
// (ingress.enableGatewayApi, ingressDomain, the kserve-ingress-gateway
// status, and whether the Envoy AI Gateway CRDs are present). The Inference
// Services + Gateway pages call this to render the "how do I reach my
// service?" banner and the Gateway page's status panel.
//
// Uses per-request impersonation so a non-admin still gets a usable result —
// if RBAC blocks the configmap or the cluster-scoped Gateway, individual
// fields fall back to zero values rather than 500'ing the page.
func (a *inferenceAPI) GatewayConfigHandler(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	cfg, err := svc.GatewayConfig(r.Context())
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// routeStatus returns the routes + rate limits that target an
// InferenceService — used by the Inference Services list (per-row chip) and
// the per-service detail page.
func (a *inferenceAPI) routeStatus(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	status, err := svc.ServiceRouteStatus(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// createGatewayRoute provisions the Envoy-AI-Gateway resources for one
// InferenceService. Returns the list of resources that were created /
// updated so the UI can show them ("we created these CRs for you").
func (a *inferenceAPI) createGatewayRoute(w http.ResponseWriter, r *http.Request) {
	var req inference.CreateAIGatewayRouteRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	res, err := svc.CreateAIGatewayRoute(
		r.Context(),
		chi.URLParam(r, "namespace"),
		chi.URLParam(r, "name"),
		req,
	)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

// LocalModelStatusHandler probes the KServe local-model-cache agent
// DaemonSet so the UI can decide whether to render the management page or
// an "install the agent first" empty state. Uses per-request impersonation
// so the call respects the caller's RBAC; a non-admin without get/daemonsets
// just sees installed=false (which collapses the page to read-only).
func (a *inferenceAPI) LocalModelStatusHandler(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	status, err := svc.LocalModelCacheStatus(r.Context())
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// LocalModelOptionsHandler returns the aggregated node-label key set plus
// the cluster's StorageClass names so the NodeGroup form can render Selects
// instead of free-text inputs. Uses per-request impersonation; non-admins
// who can't list nodes/storageclasses just get empty arrays, which the UI
// degrades to free-text.
func (a *inferenceAPI) LocalModelOptionsHandler(w http.ResponseWriter, r *http.Request) {
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	opts, err := svc.LocalModelOptions(r.Context())
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, opts)
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
