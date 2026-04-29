package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/alauda/knaic-backend/internal/admin"
)

type adminAPI struct {
	svc *admin.Service
}

func newAdminAPI(svc *admin.Service) *adminAPI {
	return &adminAPI{svc: svc}
}

func (a *adminAPI) routes(r chi.Router) {
	r.Route("/admin", func(r chi.Router) {
		r.Get("/users", a.listUsers)
		r.Patch("/users/{id}", a.patchUser)

		r.Get("/nodes", a.listNodes)
		r.Patch("/nodes/{name}", a.patchNode)

		r.Get("/namespaces", a.listNamespaces)
		r.Post("/namespaces", a.createNamespace)
		r.Patch("/namespaces/{name}/quota", a.updateNamespaceQuota)
		r.Delete("/namespaces/{name}", a.deleteNamespace)

		r.Get("/namespaces/{namespace}/roles", a.listRoles)
		r.Post("/namespaces/{namespace}/roles", a.upsertRole)
		r.Put("/namespaces/{namespace}/roles/{kind}/{name}", a.upsertRole)
		r.Delete("/namespaces/{namespace}/roles/{kind}/{name}", a.deleteRole)

		r.Get("/namespaces/{namespace}/rolebindings", a.listRoleBindings)
		r.Post("/namespaces/{namespace}/rolebindings", a.upsertRoleBinding)
		r.Put("/namespaces/{namespace}/rolebindings/{name}", a.upsertRoleBinding)
		r.Delete("/namespaces/{namespace}/rolebindings/{name}", a.deleteRoleBinding)
	})
}

func (a *adminAPI) listUsers(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.svc.ListUsers())
}

func (a *adminAPI) patchUser(w http.ResponseWriter, r *http.Request) {
	var patch admin.UserPatch
	if err := decodeJSON(r, &patch); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u, err := a.svc.PatchUser(chi.URLParam(r, "id"), patch)
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (a *adminAPI) listNodes(w http.ResponseWriter, r *http.Request) {
	nodes, err := a.svc.ListNodes(r.Context())
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, nodes)
}

func (a *adminAPI) patchNode(w http.ResponseWriter, r *http.Request) {
	var patch admin.NodePatch
	if err := decodeJSON(r, &patch); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	n, err := a.svc.PatchNode(r.Context(), chi.URLParam(r, "name"), patch)
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (a *adminAPI) listNamespaces(w http.ResponseWriter, r *http.Request) {
	namespaces, err := a.svc.ListNamespaces(r.Context())
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, namespaces)
}

func (a *adminAPI) createNamespace(w http.ResponseWriter, r *http.Request) {
	var req admin.NamespaceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	ns, err := a.svc.CreateNamespace(r.Context(), req)
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, ns)
}

func (a *adminAPI) updateNamespaceQuota(w http.ResponseWriter, r *http.Request) {
	var quota admin.Quota
	if err := decodeJSON(r, &quota); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	ns, err := a.svc.UpdateNamespaceQuota(r.Context(), chi.URLParam(r, "name"), quota)
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ns)
}

func (a *adminAPI) deleteNamespace(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.DeleteNamespace(r.Context(), chi.URLParam(r, "name")); err != nil {
		writeAdminError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *adminAPI) listRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := a.svc.ListRoles(r.Context(), chi.URLParam(r, "namespace"))
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, roles)
}

func (a *adminAPI) upsertRole(w http.ResponseWriter, r *http.Request) {
	var req admin.Role
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	if req.Name == "" {
		req.Name = chi.URLParam(r, "name")
	}
	if req.Kind == "" {
		req.Kind = chi.URLParam(r, "kind")
	}
	role, err := a.svc.UpsertRole(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, role)
}

func (a *adminAPI) deleteRole(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.DeleteRole(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "kind"), chi.URLParam(r, "name")); err != nil {
		writeAdminError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *adminAPI) listRoleBindings(w http.ResponseWriter, r *http.Request) {
	bindings, err := a.svc.ListRoleBindings(r.Context(), chi.URLParam(r, "namespace"))
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bindings)
}

func (a *adminAPI) upsertRoleBinding(w http.ResponseWriter, r *http.Request) {
	var req admin.RoleBinding
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	if req.Name == "" {
		req.Name = chi.URLParam(r, "name")
	}
	binding, err := a.svc.UpsertRoleBinding(r.Context(), chi.URLParam(r, "namespace"), req)
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, binding)
}

func (a *adminAPI) deleteRoleBinding(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.DeleteRoleBinding(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name")); err != nil {
		writeAdminError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeAdminError(w http.ResponseWriter, err error) {
	switch {
	case apierrors.IsNotFound(err):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	case apierrors.IsAlreadyExists(err) || apierrors.IsConflict(err):
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
	case apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err):
		writeJSON(w, http.StatusForbidden, apiError{Error: err.Error()})
	case errors.Is(err, admin.ErrNotFound):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	}
}
