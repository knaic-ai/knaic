package api

import (
	"net/http"
	"sort"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/alauda/knaic-backend/internal/admin"
	"github.com/alauda/knaic-backend/internal/auth"
)

// newMyNamespacesHandler returns the lightweight namespace list scoped to the
// caller's K8s RBAC. Admins fall through to the SA-backed list so the
// selector matches the rest of the platform-admin views.
func newMyNamespacesHandler(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := auth.MustFromContext(r.Context())
		if u.IsPlatformAdmin || d.K8s == nil {
			list, err := d.Admin.ListNamespaceRefs(r.Context())
			if err != nil {
				writeAdminError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, list)
			return
		}
		username := impersonatedUsername(u, d.UserClaim, d.UserPrefix)
		if username == "" {
			// No impersonation identity available; fall back to empty list
			// rather than leaking the full cluster contents.
			writeJSON(w, http.StatusOK, []admin.NamespaceRef{})
			return
		}
		client, err := d.K8s.Impersonate(username, u.Groups)
		if err != nil {
			writeAdminError(w, err)
			return
		}
		list, err := client.CoreV1().Namespaces().List(r.Context(), metav1.ListOptions{})
		if err != nil {
			writeAdminError(w, err)
			return
		}
		out := make([]admin.NamespaceRef, 0, len(list.Items))
		for i := range list.Items {
			ns := &list.Items[i]
			out = append(out, admin.NamespaceRef{Name: ns.Name, Status: string(ns.Status.Phase)})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
		writeJSON(w, http.StatusOK, out)
	}
}

func impersonatedUsername(u *auth.User, claim, prefix string) string {
	var v string
	switch claim {
	case "sub":
		v = u.Subject
	case "name":
		v = u.Name
	case "email", "":
		v = u.Email
	default:
		v = u.Email
	}
	if v == "" {
		return ""
	}
	return prefix + v
}
