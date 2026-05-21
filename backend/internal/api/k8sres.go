package api

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/yaml"

	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/k8sres"
)

type k8sresAPI struct {
	svc    *k8sres.Service
	source k8sClientSource
}

func newK8sresAPI(svc *k8sres.Service, source k8sClientSource) *k8sresAPI {
	return &k8sresAPI{svc: svc, source: source}
}

func (a *k8sresAPI) routes(r chi.Router) {
	// Namespaced
	r.Route("/namespaces/{namespace}/{slug}", func(r chi.Router) {
		r.Get("/", a.list)
		r.With(auth.RequirePlatformAdmin).Post("/", a.create)
		r.Get("/{name}", a.get)
		r.Get("/{name}/yaml", a.yaml)
		r.With(auth.RequirePlatformAdmin).Put("/{name}", a.update)
		r.With(auth.RequirePlatformAdmin).Patch("/{name}", a.update)
		r.With(auth.RequirePlatformAdmin).Delete("/{name}", a.delete)
		r.Get("/{name}/logs", a.logs) // pods only — handler validates
	})
	// Cluster-scoped
	r.Route("/cluster/{slug}", func(r chi.Router) {
		r.Get("/", a.listCluster)
		r.With(auth.RequirePlatformAdmin).Post("/", a.createCluster)
		r.Get("/{name}", a.getCluster)
		r.Get("/{name}/yaml", a.yamlCluster)
		r.With(auth.RequirePlatformAdmin).Put("/{name}", a.updateCluster)
		r.With(auth.RequirePlatformAdmin).Patch("/{name}", a.updateCluster)
		r.With(auth.RequirePlatformAdmin).Delete("/{name}", a.deleteCluster)
	})
}

func (a *k8sresAPI) lookup(slug string, wantNamespaced bool, w http.ResponseWriter) (k8sres.Kind, bool) {
	k, err := k8sres.Lookup(slug)
	if err != nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
		return k8sres.Kind{}, false
	}
	if k.Namespaced != wantNamespaced {
		got := "namespaced"
		if !k.Namespaced {
			got = "cluster-scoped"
		}
		writeJSON(w, http.StatusBadRequest, apiError{Error: "wrong scope: " + slug + " is " + got})
		return k8sres.Kind{}, false
	}
	return k, true
}

func writeK8sError(w http.ResponseWriter, err error) {
	switch {
	case apierrors.IsNotFound(err):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	case apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err):
		writeJSON(w, http.StatusForbidden, apiError{Error: err.Error()})
	case apierrors.IsConflict(err):
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
	}
}

func (a *k8sresAPI) list(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), true, w)
	if !ok {
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	items, err := svc.List(r.Context(), k, chi.URLParam(r, "namespace"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *k8sresAPI) get(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), true, w)
	if !ok {
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	item, err := svc.Get(r.Context(), k, chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *k8sresAPI) create(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), true, w)
	if !ok {
		return
	}
	obj, err := decodeK8sObject(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	item, err := svc.Create(r.Context(), k, chi.URLParam(r, "namespace"), obj)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *k8sresAPI) update(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), true, w)
	if !ok {
		return
	}
	obj, err := decodeK8sObject(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	item, err := svc.Update(r.Context(), k, chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), obj)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *k8sresAPI) yaml(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), true, w)
	if !ok {
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out, err := svc.YAML(r.Context(), k, chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-yaml; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func (a *k8sresAPI) delete(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), true, w)
	if !ok {
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	if err := svc.Delete(r.Context(), k, chi.URLParam(r, "namespace"), chi.URLParam(r, "name")); err != nil {
		writeK8sError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *k8sresAPI) logs(w http.ResponseWriter, r *http.Request) {
	if chi.URLParam(r, "slug") != "pods" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "logs are only available for pods"})
		return
	}
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
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	err = svc.StreamPodLogs(r.Context(), w, chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), opts)
	if err != nil && !errors.Is(err, http.ErrAbortHandler) {
		// Headers may already be flushed — log only.
		_ = err
	}
}

// ---- cluster-scoped handlers (mirror namespaced ones) -------------------

func (a *k8sresAPI) listCluster(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), false, w)
	if !ok {
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	items, err := svc.List(r.Context(), k, "")
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *k8sresAPI) getCluster(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), false, w)
	if !ok {
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	item, err := svc.Get(r.Context(), k, "", chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *k8sresAPI) createCluster(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), false, w)
	if !ok {
		return
	}
	obj, err := decodeK8sObject(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	item, err := svc.Create(r.Context(), k, "", obj)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *k8sresAPI) updateCluster(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), false, w)
	if !ok {
		return
	}
	obj, err := decodeK8sObject(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	item, err := svc.Update(r.Context(), k, "", chi.URLParam(r, "name"), obj)
	if err != nil {
		writeK8sError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *k8sresAPI) yamlCluster(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), false, w)
	if !ok {
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	out, err := svc.YAML(r.Context(), k, "", chi.URLParam(r, "name"))
	if err != nil {
		writeK8sError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-yaml; charset=utf-8")
	_, _ = w.Write(out)
}

func (a *k8sresAPI) deleteCluster(w http.ResponseWriter, r *http.Request) {
	k, ok := a.lookup(chi.URLParam(r, "slug"), false, w)
	if !ok {
		return
	}
	svc, err := a.service(r)
	if err != nil {
		writeK8sClientError(w, err)
		return
	}
	if err := svc.Delete(r.Context(), k, "", chi.URLParam(r, "name")); err != nil {
		writeK8sError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *k8sresAPI) service(r *http.Request) (*k8sres.Service, error) {
	if a.source.authDisabled {
		return a.svc, nil
	}
	clients, err := a.source.clientsForRequest(r)
	if err != nil {
		return nil, err
	}
	return k8sres.NewService(clients.Dynamic, clients.Typed), nil
}

func decodeK8sObject(r *http.Request) (map[string]any, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	var obj map[string]any
	if err := yaml.Unmarshal(body, &obj); err != nil {
		return nil, err
	}
	return obj, nil
}
