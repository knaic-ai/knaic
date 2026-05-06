package k8s

import (
	"context"
	"fmt"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/alauda/knaic-backend/internal/auth"
)

type Authorizer struct {
	clients      *Clients
	userClaim    string
	userPrefix   string
	authDisabled bool
}

func NewAuthorizer(clients *Clients, userClaim, userPrefix string, authDisabled bool) *Authorizer {
	return &Authorizer{
		clients:      clients,
		userClaim:    userClaim,
		userPrefix:   userPrefix,
		authDisabled: authDisabled,
	}
}

func UsernameFromUser(u *auth.User, claim, prefix string) string {
	if u == nil {
		return ""
	}
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

func (a *Authorizer) CanI(ctx context.Context, u *auth.User, attrs authorizationv1.ResourceAttributes) (bool, error) {
	if u == nil {
		return false, nil
	}
	if a == nil {
		return false, nil
	}
	if a.authDisabled || u.IsPlatformAdmin {
		return true, nil
	}
	if a.clients == nil || a.clients.Typed == nil {
		return false, nil
	}
	username := UsernameFromUser(u, a.userClaim, a.userPrefix)
	if username == "" {
		return false, nil
	}
	sar := &authorizationv1.SubjectAccessReview{
		Spec: authorizationv1.SubjectAccessReviewSpec{
			User:               username,
			Groups:             u.Groups,
			ResourceAttributes: &attrs,
		},
	}
	out, err := a.clients.Typed.AuthorizationV1().SubjectAccessReviews().Create(ctx, sar, metav1.CreateOptions{})
	if err != nil {
		return false, fmt.Errorf("subject access review: %w", err)
	}
	return out.Status.Allowed, nil
}

func (a *Authorizer) CanWritePrivateModel(ctx context.Context, u *auth.User, namespace string) (bool, error) {
	return a.CanI(ctx, u, authorizationv1.ResourceAttributes{
		Namespace: namespace,
		Verb:      "create",
		Group:     "",
		Resource:  "configmaps",
	})
}
