package api

import (
	"errors"
	"net/http"

	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/k8s"
)

var errNoK8sImpersonationIdentity = errors.New("no Kubernetes impersonation identity")

type k8sClientSource struct {
	base         *k8s.Clients
	userClaim    string
	userPrefix   string
	authDisabled bool
}

func newK8sClientSource(d Deps) k8sClientSource {
	return k8sClientSource{
		base:         d.K8s,
		userClaim:    d.UserClaim,
		userPrefix:   d.UserPrefix,
		authDisabled: d.AuthDisabled,
	}
}

func (s k8sClientSource) clientsForRequest(r *http.Request) (*k8s.UserClients, error) {
	if s.base == nil {
		return nil, errors.New("k8s clients not initialized")
	}
	if s.authDisabled {
		return s.base.Base()
	}
	u := auth.MustFromContext(r.Context())
	username := k8s.UsernameFromUser(u, s.userClaim, s.userPrefix)
	if username == "" {
		return nil, errNoK8sImpersonationIdentity
	}
	return s.base.Impersonate(username, u.Groups)
}

func writeK8sClientError(w http.ResponseWriter, err error) {
	if errors.Is(err, errNoK8sImpersonationIdentity) {
		writeJSON(w, http.StatusForbidden, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
}
