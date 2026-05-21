package auth

import (
	"context"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// UsernameFunc derives the apiserver-side username for a User, matching the
// `--oidc-username-claim` / `--oidc-username-prefix` flags on the apiserver
// (and the impersonation headers knaic forwards). The same function is used
// by k8s.UsernameFromUser; the indirection keeps internal/auth from
// importing internal/k8s.
type UsernameFunc func(*User) string

// AdminResolver decides whether an OIDC-authenticated user is a platform
// admin by inspecting cluster-scoped RoleBindings on the apiserver. A user
// is admin if any ClusterRoleBinding pointing at one of the configured
// admin ClusterRoles (typically `cluster-admin`) has the user as a subject
// directly, or via any of their groups.
//
// The CRB list rarely changes — we cache it for `ttl` (default 60s) so the
// per-request cost is a map lookup, not an apiserver round-trip.
//
// The resolver intentionally mirrors only ClusterRoleBindings (not
// per-namespace RoleBindings). "Platform admin" is a cluster-scope concept
// in knaic; namespace bindings are enforced by the apiserver via
// impersonation, not by knaic's own gating.
type AdminResolver struct {
	typed       kubernetes.Interface
	roleNames   map[string]bool
	usernameFn  UsernameFunc
	ttl         time.Duration

	mu       sync.Mutex
	cache    *adminSubjects
	cachedAt time.Time
}

// adminSubjects is the deduped union of subjects across every CRB that
// targets one of our admin ClusterRoles.
type adminSubjects struct {
	users           map[string]bool
	groups          map[string]bool
	serviceAccounts map[string]bool // "<ns>/<name>" — surfaced for completeness; knaic-api itself runs under one
}

// NewAdminResolver builds a CRB-backed resolver. typed must be the
// backend SA's client (it needs cluster-wide `list clusterrolebindings`
// — the SA already has cluster-admin in the dev manifest, and the
// production `knaic-impersonator` role should also grant this).
// roleNames is the set of ClusterRole names that confer platform-admin
// (case-sensitive, matched exactly against `roleRef.name`).
// usernameFn derives the apiserver-side identity from a User; pass the
// same function k8s.UsernameFromUser implements so CRB subjects line up
// with the impersonation headers knaic forwards.
func NewAdminResolver(typed kubernetes.Interface, roleNames []string, usernameFn UsernameFunc) *AdminResolver {
	if typed == nil || len(roleNames) == 0 {
		return nil
	}
	roleSet := make(map[string]bool, len(roleNames))
	for _, r := range roleNames {
		if r != "" {
			roleSet[r] = true
		}
	}
	return &AdminResolver{
		typed:      typed,
		roleNames:  roleSet,
		usernameFn: usernameFn,
		ttl:        60 * time.Second,
	}
}

// IsAdmin returns true when the user holds a CRB to one of the configured
// admin ClusterRoles, either directly (subject kind=User, name=<username>)
// or via group membership (subject kind=Group, name=<one of u.Groups>).
//
// Soft-fail: any apiserver / network error is swallowed and we return
// false. The caller already has the group-claim path as the primary signal;
// this resolver is an additive check.
func (r *AdminResolver) IsAdmin(ctx context.Context, u *User) bool {
	if r == nil || u == nil {
		return false
	}
	snap, err := r.snapshot(ctx)
	if err != nil || snap == nil {
		return false
	}
	if r.usernameFn != nil {
		if name := r.usernameFn(u); name != "" && snap.users[name] {
			return true
		}
	}
	for _, g := range u.Groups {
		if snap.groups[g] {
			return true
		}
	}
	return false
}

func (r *AdminResolver) snapshot(ctx context.Context) (*adminSubjects, error) {
	r.mu.Lock()
	if r.cache != nil && time.Since(r.cachedAt) < r.ttl {
		c := r.cache
		r.mu.Unlock()
		return c, nil
	}
	r.mu.Unlock()

	list, err := r.typed.RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	b := &adminSubjects{
		users:           map[string]bool{},
		groups:          map[string]bool{},
		serviceAccounts: map[string]bool{},
	}
	for _, crb := range list.Items {
		if crb.RoleRef.Kind != "ClusterRole" || !r.roleNames[crb.RoleRef.Name] {
			continue
		}
		for _, s := range crb.Subjects {
			switch s.Kind {
			case "User":
				b.users[s.Name] = true
			case "Group":
				b.groups[s.Name] = true
			case "ServiceAccount":
				b.serviceAccounts[s.Namespace+"/"+s.Name] = true
			}
		}
	}

	r.mu.Lock()
	r.cache = b
	r.cachedAt = time.Now()
	r.mu.Unlock()
	return b, nil
}

