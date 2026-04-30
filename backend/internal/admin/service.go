package admin

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"

	"github.com/alauda/knaic-backend/internal/auth"
)

const quotaName = "knaic-quota"

var ErrNotFound = errors.New("admin resource not found")

type Service struct {
	typed kubernetes.Interface
	users *UserStore
}

func NewService(typed kubernetes.Interface) *Service {
	return &Service{typed: typed, users: NewUserStore()}
}

func (s *Service) ObserveUser(u *auth.User) UserRecord {
	return s.users.Observe(u)
}

func (s *Service) ListUsers() []UserRecord {
	return s.users.List()
}

func (s *Service) PatchUser(id string, patch UserPatch) (UserRecord, error) {
	return s.users.Patch(id, patch)
}

func (s *Service) ListNodes(ctx context.Context) ([]NodeInfo, error) {
	if err := s.requireClient(); err != nil {
		return nil, err
	}
	list, err := s.typed.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]NodeInfo, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, projectNode(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Service) PatchNode(ctx context.Context, name string, patch NodePatch) (NodeInfo, error) {
	if err := s.requireClient(); err != nil {
		return NodeInfo{}, err
	}
	n, err := s.typed.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return NodeInfo{}, err
	}
	if patch.Labels != nil {
		n.Labels = patch.Labels
	}
	if patch.Taints != nil {
		n.Spec.Taints = toCoreTaints(patch.Taints)
	}
	updated, err := s.typed.CoreV1().Nodes().Update(ctx, n, metav1.UpdateOptions{})
	if err != nil {
		return NodeInfo{}, err
	}
	return projectNode(updated), nil
}

// ListNamespaceRefs returns the lightweight name+status pairs used by the
// namespace selector. Public to any authenticated caller — see ListNamespaces
// for the admin-only shape.
func (s *Service) ListNamespaceRefs(ctx context.Context) ([]NamespaceRef, error) {
	if err := s.requireClient(); err != nil {
		return nil, err
	}
	list, err := s.typed.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]NamespaceRef, 0, len(list.Items))
	for i := range list.Items {
		ns := &list.Items[i]
		out = append(out, NamespaceRef{Name: ns.Name, Status: string(ns.Status.Phase)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Service) ListNamespaces(ctx context.Context) ([]Namespace, error) {
	if err := s.requireClient(); err != nil {
		return nil, err
	}
	list, err := s.typed.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]Namespace, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, s.projectNamespace(ctx, &list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Service) CreateNamespace(ctx context.Context, req NamespaceRequest) (Namespace, error) {
	if err := s.requireClient(); err != nil {
		return Namespace{}, err
	}
	if req.Name == "" {
		return Namespace{}, errors.New("name is required")
	}
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name:   req.Name,
			Labels: req.Labels,
		},
	}
	created, err := s.typed.CoreV1().Namespaces().Create(ctx, ns, metav1.CreateOptions{})
	if err != nil && !apierrors.IsAlreadyExists(err) {
		return Namespace{}, err
	}
	if apierrors.IsAlreadyExists(err) {
		created, err = s.typed.CoreV1().Namespaces().Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			return Namespace{}, err
		}
	}
	if err := s.upsertQuota(ctx, req.Name, req.Quota); err != nil {
		return Namespace{}, err
	}
	return s.projectNamespace(ctx, created), nil
}

func (s *Service) UpdateNamespaceQuota(ctx context.Context, name string, quota Quota) (Namespace, error) {
	if err := s.requireClient(); err != nil {
		return Namespace{}, err
	}
	if err := s.upsertQuota(ctx, name, quota); err != nil {
		return Namespace{}, err
	}
	ns, err := s.typed.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return Namespace{}, err
	}
	return s.projectNamespace(ctx, ns), nil
}

func (s *Service) DeleteNamespace(ctx context.Context, name string) error {
	if err := s.requireClient(); err != nil {
		return err
	}
	return s.typed.CoreV1().Namespaces().Delete(ctx, name, metav1.DeleteOptions{})
}

func (s *Service) ListRoles(ctx context.Context, namespace string) ([]Role, error) {
	if err := s.requireClient(); err != nil {
		return nil, err
	}
	roles, err := s.typed.RbacV1().Roles(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]Role, 0, len(roles.Items))
	for i := range roles.Items {
		out = append(out, fromK8sRole(&roles.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Service) UpsertRole(ctx context.Context, namespace string, in Role) (Role, error) {
	if err := s.requireClient(); err != nil {
		return Role{}, err
	}
	if in.Name == "" {
		return Role{}, errors.New("name is required")
	}
	if in.Kind == "" {
		in.Kind = "Role"
	}
	switch in.Kind {
	case "Role":
		obj := &rbacv1.Role{
			ObjectMeta: metav1.ObjectMeta{Name: in.Name, Namespace: namespace},
			Rules:      toPolicyRules(in.Rules),
		}
		existing, err := s.typed.RbacV1().Roles(namespace).Get(ctx, in.Name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			created, err := s.typed.RbacV1().Roles(namespace).Create(ctx, obj, metav1.CreateOptions{})
			if err != nil {
				return Role{}, err
			}
			return fromK8sRole(created), nil
		}
		if err != nil {
			return Role{}, err
		}
		obj.ResourceVersion = existing.ResourceVersion
		updated, err := s.typed.RbacV1().Roles(namespace).Update(ctx, obj, metav1.UpdateOptions{})
		if err != nil {
			return Role{}, err
		}
		return fromK8sRole(updated), nil
	case "ClusterRole":
		obj := &rbacv1.ClusterRole{
			ObjectMeta: metav1.ObjectMeta{Name: in.Name},
			Rules:      toPolicyRules(in.Rules),
		}
		existing, err := s.typed.RbacV1().ClusterRoles().Get(ctx, in.Name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			created, err := s.typed.RbacV1().ClusterRoles().Create(ctx, obj, metav1.CreateOptions{})
			if err != nil {
				return Role{}, err
			}
			return fromK8sClusterRole(created), nil
		}
		if err != nil {
			return Role{}, err
		}
		obj.ResourceVersion = existing.ResourceVersion
		updated, err := s.typed.RbacV1().ClusterRoles().Update(ctx, obj, metav1.UpdateOptions{})
		if err != nil {
			return Role{}, err
		}
		return fromK8sClusterRole(updated), nil
	default:
		return Role{}, fmt.Errorf("unknown role kind %q", in.Kind)
	}
}

func (s *Service) DeleteRole(ctx context.Context, namespace, kind, name string) error {
	if err := s.requireClient(); err != nil {
		return err
	}
	switch kind {
	case "Role", "":
		return s.typed.RbacV1().Roles(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	case "ClusterRole":
		return s.typed.RbacV1().ClusterRoles().Delete(ctx, name, metav1.DeleteOptions{})
	default:
		return fmt.Errorf("unknown role kind %q", kind)
	}
}

func (s *Service) ListRoleBindings(ctx context.Context, namespace string) ([]RoleBinding, error) {
	if err := s.requireClient(); err != nil {
		return nil, err
	}
	bindings, err := s.typed.RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]RoleBinding, 0, len(bindings.Items))
	for i := range bindings.Items {
		out = append(out, fromK8sRoleBinding(&bindings.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Service) UpsertRoleBinding(ctx context.Context, namespace string, in RoleBinding) (RoleBinding, error) {
	if err := s.requireClient(); err != nil {
		return RoleBinding{}, err
	}
	if in.Name == "" || in.RoleRef.Name == "" {
		return RoleBinding{}, errors.New("name and roleRef.name are required")
	}
	if in.RoleRef.Kind == "" {
		in.RoleRef.Kind = "Role"
	}
	obj := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: in.Name, Namespace: namespace},
		RoleRef: rbacv1.RoleRef{
			APIGroup: rbacv1.GroupName,
			Kind:     in.RoleRef.Kind,
			Name:     in.RoleRef.Name,
		},
		Subjects: toSubjects(in.Subjects),
	}
	existing, err := s.typed.RbacV1().RoleBindings(namespace).Get(ctx, in.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		created, err := s.typed.RbacV1().RoleBindings(namespace).Create(ctx, obj, metav1.CreateOptions{})
		if err != nil {
			return RoleBinding{}, err
		}
		return fromK8sRoleBinding(created), nil
	}
	if err != nil {
		return RoleBinding{}, err
	}
	obj.ResourceVersion = existing.ResourceVersion
	updated, err := s.typed.RbacV1().RoleBindings(namespace).Update(ctx, obj, metav1.UpdateOptions{})
	if err != nil {
		return RoleBinding{}, err
	}
	return fromK8sRoleBinding(updated), nil
}

func (s *Service) DeleteRoleBinding(ctx context.Context, namespace, name string) error {
	if err := s.requireClient(); err != nil {
		return err
	}
	return s.typed.RbacV1().RoleBindings(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func projectNode(n *corev1.Node) NodeInfo {
	gpuCount, gpuProduct := gpuInfo(n)
	role := "worker"
	if _, ok := n.Labels["node-role.kubernetes.io/control-plane"]; ok {
		role = "control-plane"
	} else if _, ok := n.Labels["node-role.kubernetes.io/master"]; ok {
		role = "control-plane"
	} else if gpuCount != "" && gpuCount != "0" {
		role = "gpu-worker"
	}
	status := "NotReady"
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
			status = "Ready"
			break
		}
	}
	return NodeInfo{
		Name:    n.Name,
		Role:    role,
		CPU:     quantityString(n.Status.Capacity[corev1.ResourceCPU]),
		Memory:  quantityString(n.Status.Capacity[corev1.ResourceMemory]),
		GPU:     formatGPU(gpuCount, gpuProduct),
		Status:  status,
		Kubelet: n.Status.NodeInfo.KubeletVersion,
		Kernel:  n.Status.NodeInfo.KernelVersion,
		Labels:  cloneStringMap(n.Labels),
		Taints:  fromCoreTaints(n.Spec.Taints),
	}
}

func gpuInfo(n *corev1.Node) (count, product string) {
	product = n.Labels["nvidia.com/gpu.product"]
	for name, q := range n.Status.Capacity {
		if strings.Contains(string(name), "gpu") {
			return q.String(), product
		}
	}
	return "-", product
}

func formatGPU(count, product string) string {
	if count == "" || count == "-" || count == "0" {
		return "-"
	}
	if product == "" {
		return count
	}
	return count + " x " + product
}

func quantityString(q resource.Quantity) string {
	if q.IsZero() {
		return ""
	}
	return q.String()
}

func fromCoreTaints(in []corev1.Taint) []Taint {
	out := make([]Taint, 0, len(in))
	for _, t := range in {
		out = append(out, Taint{Key: t.Key, Value: t.Value, Effect: string(t.Effect)})
	}
	return out
}

func toCoreTaints(in []Taint) []corev1.Taint {
	out := make([]corev1.Taint, 0, len(in))
	for _, t := range in {
		out = append(out, corev1.Taint{Key: t.Key, Value: t.Value, Effect: corev1.TaintEffect(t.Effect)})
	}
	return out
}

func (s *Service) projectNamespace(ctx context.Context, ns *corev1.Namespace) Namespace {
	q := Quota{}
	rq, err := s.typed.CoreV1().ResourceQuotas(ns.Name).Get(ctx, quotaName, metav1.GetOptions{})
	if err == nil {
		q = quotaFromResourceQuota(rq)
	}
	return Namespace{
		Name:   ns.Name,
		Status: string(ns.Status.Phase),
		Labels: cloneStringMap(ns.Labels),
		Quota:  q,
	}
}

func (s *Service) upsertQuota(ctx context.Context, namespace string, quota Quota) error {
	rq := &corev1.ResourceQuota{
		ObjectMeta: metav1.ObjectMeta{
			Name:      quotaName,
			Namespace: namespace,
			Labels: map[string]string{
				"knaic.io/managed": "true",
			},
		},
		Spec: corev1.ResourceQuotaSpec{Hard: quotaToResourceList(quota)},
	}
	existing, err := s.typed.CoreV1().ResourceQuotas(namespace).Get(ctx, quotaName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err := s.typed.CoreV1().ResourceQuotas(namespace).Create(ctx, rq, metav1.CreateOptions{})
		return err
	}
	if err != nil {
		return err
	}
	rq.ResourceVersion = existing.ResourceVersion
	_, err = s.typed.CoreV1().ResourceQuotas(namespace).Update(ctx, rq, metav1.UpdateOptions{})
	return err
}

func quotaToResourceList(q Quota) corev1.ResourceList {
	hard := corev1.ResourceList{}
	if q.CPU > 0 {
		cpu := resource.MustParse(fmt.Sprintf("%d", q.CPU))
		hard[corev1.ResourceRequestsCPU] = cpu
		hard[corev1.ResourceLimitsCPU] = cpu
	}
	if q.MemoryGi > 0 {
		mem := resource.MustParse(fmt.Sprintf("%dGi", q.MemoryGi))
		hard[corev1.ResourceRequestsMemory] = mem
		hard[corev1.ResourceLimitsMemory] = mem
	}
	if q.GPU > 0 {
		hard[corev1.ResourceName("requests.nvidia.com/gpu")] = resource.MustParse(fmt.Sprintf("%d", q.GPU))
	}
	if q.Pods > 0 {
		hard[corev1.ResourcePods] = resource.MustParse(fmt.Sprintf("%d", q.Pods))
	}
	return hard
}

func quotaFromResourceQuota(rq *corev1.ResourceQuota) Quota {
	h := rq.Spec.Hard
	return Quota{
		CPU:      quantityValue(h[corev1.ResourceRequestsCPU]),
		MemoryGi: quantityValue(h[corev1.ResourceRequestsMemory]) / (1024 * 1024 * 1024),
		GPU:      quantityValue(h[corev1.ResourceName("requests.nvidia.com/gpu")]),
		Pods:     quantityValue(h[corev1.ResourcePods]),
	}
}

func quantityValue(q resource.Quantity) int64 {
	return q.Value()
}

func fromK8sRole(r *rbacv1.Role) Role {
	return Role{
		ID:        r.Namespace + "/Role/" + r.Name,
		Name:      r.Name,
		Namespace: r.Namespace,
		Kind:      "Role",
		Rules:     fromPolicyRules(r.Rules),
	}
}

func fromK8sClusterRole(r *rbacv1.ClusterRole) Role {
	return Role{
		ID:    "cluster/ClusterRole/" + r.Name,
		Name:  r.Name,
		Kind:  "ClusterRole",
		Rules: fromPolicyRules(r.Rules),
	}
}

func toPolicyRules(in []PolicyRule) []rbacv1.PolicyRule {
	out := make([]rbacv1.PolicyRule, 0, len(in))
	for _, r := range in {
		out = append(out, rbacv1.PolicyRule{
			APIGroups: r.APIGroups,
			Resources: r.Resources,
			Verbs:     r.Verbs,
		})
	}
	return out
}

func fromPolicyRules(in []rbacv1.PolicyRule) []PolicyRule {
	out := make([]PolicyRule, 0, len(in))
	for _, r := range in {
		out = append(out, PolicyRule{
			APIGroups: r.APIGroups,
			Resources: r.Resources,
			Verbs:     r.Verbs,
		})
	}
	return out
}

func fromK8sRoleBinding(b *rbacv1.RoleBinding) RoleBinding {
	return RoleBinding{
		ID:        b.Namespace + "/" + b.Name,
		Name:      b.Name,
		Namespace: b.Namespace,
		RoleRef:   RoleRef{Kind: b.RoleRef.Kind, Name: b.RoleRef.Name},
		Subjects:  fromSubjects(b.Subjects),
	}
}

func toSubjects(in []Subject) []rbacv1.Subject {
	out := make([]rbacv1.Subject, 0, len(in))
	for _, s := range in {
		out = append(out, rbacv1.Subject{
			Kind:     s.Kind,
			APIGroup: rbacv1.GroupName,
			Name:     s.Name,
		})
	}
	return out
}

func fromSubjects(in []rbacv1.Subject) []Subject {
	out := make([]Subject, 0, len(in))
	for _, s := range in {
		out = append(out, Subject{Kind: s.Kind, Name: s.Name})
	}
	return out
}

func cloneStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

type UserStore struct {
	mu    sync.RWMutex
	items map[string]UserRecord
}

func NewUserStore() *UserStore {
	return &UserStore{items: map[string]UserRecord{}}
}

func (s *UserStore) Observe(u *auth.User) UserRecord {
	now := time.Now().UTC()
	id := u.Subject
	if id == "" {
		id = u.Name
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.items[id]
	if !ok {
		rec = UserRecord{
			ID:          id,
			OIDCSub:     u.Subject,
			FirstSeen:   now,
			Memberships: map[string]NamespaceRole{},
		}
	}
	rec.Name = u.Name
	rec.Email = u.Email
	rec.LastSeen = now
	rec.IsPlatformAdmin = u.IsPlatformAdmin
	s.items[id] = rec
	return rec
}

func (s *UserStore) List() []UserRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]UserRecord, 0, len(s.items))
	for _, u := range s.items {
		u.Memberships = cloneMemberships(u.Memberships)
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (s *UserStore) Patch(id string, patch UserPatch) (UserRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.items[id]
	if !ok {
		return UserRecord{}, apierrors.NewNotFound(schema.GroupResource{Group: "knaic.io", Resource: "users"}, id)
	}
	if patch.IsPlatformAdmin != nil {
		rec.IsPlatformAdmin = *patch.IsPlatformAdmin
	}
	if patch.Memberships != nil {
		rec.Memberships = cloneMemberships(patch.Memberships)
	}
	s.items[id] = rec
	return rec, nil
}

func cloneMemberships(in map[string]NamespaceRole) map[string]NamespaceRole {
	out := make(map[string]NamespaceRole, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func MergePatchNodeLabels(labels map[string]string) []byte {
	patch := `{"metadata":{"labels":{`
	first := true
	for k, v := range labels {
		if !first {
			patch += ","
		}
		first = false
		patch += fmt.Sprintf("%q:%q", k, v)
	}
	patch += `}}}`
	return []byte(patch)
}

func (s *Service) PatchNodeLabels(ctx context.Context, name string, labels map[string]string) (NodeInfo, error) {
	if err := s.requireClient(); err != nil {
		return NodeInfo{}, err
	}
	_, err := s.typed.CoreV1().Nodes().Patch(ctx, name, types.MergePatchType, MergePatchNodeLabels(labels), metav1.PatchOptions{})
	if err != nil {
		return NodeInfo{}, err
	}
	n, err := s.typed.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return NodeInfo{}, err
	}
	return projectNode(n), nil
}

func (s *Service) requireClient() error {
	if s.typed == nil {
		return errors.New("kubernetes client unavailable")
	}
	return nil
}
