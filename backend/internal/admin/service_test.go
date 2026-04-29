package admin

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestListNodesProjectsStatusRoleAndAccelerators(t *testing.T) {
	ctx := context.Background()
	client := fake.NewSimpleClientset(&corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "gpu-node-01",
			Labels: map[string]string{
				"nvidia.com/gpu.product": "A100-SXM4-80GB",
			},
		},
		Spec: corev1.NodeSpec{
			Taints: []corev1.Taint{{Key: "nvidia.com/gpu", Value: "present", Effect: corev1.TaintEffectNoSchedule}},
		},
		Status: corev1.NodeStatus{
			NodeInfo: corev1.NodeSystemInfo{KubeletVersion: "v1.31.0", KernelVersion: "6.1.0"},
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU:                    resource.MustParse("64"),
				corev1.ResourceMemory:                 resource.MustParse("512Gi"),
				corev1.ResourceName("nvidia.com/gpu"): resource.MustParse("8"),
			},
			Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}},
		},
	})
	svc := NewService(client)

	nodes, err := svc.ListNodes(ctx)
	if err != nil {
		t.Fatalf("list nodes: %v", err)
	}
	if len(nodes) != 1 {
		t.Fatalf("len(nodes) = %d, want 1", len(nodes))
	}
	got := nodes[0]
	if got.Role != "gpu-worker" || got.Status != "Ready" || got.GPU != "8 x A100-SXM4-80GB" {
		t.Fatalf("unexpected node projection: %#v", got)
	}
	if len(got.Taints) != 1 || got.Taints[0].Effect != "NoSchedule" {
		t.Fatalf("unexpected taints: %#v", got.Taints)
	}
}

func TestCreateNamespaceCreatesResourceQuota(t *testing.T) {
	ctx := context.Background()
	client := fake.NewSimpleClientset()
	svc := NewService(client)

	ns, err := svc.CreateNamespace(ctx, NamespaceRequest{
		Name: "team-ai",
		Quota: Quota{
			CPU:      32,
			MemoryGi: 128,
			GPU:      4,
			Pods:     200,
		},
	})
	if err != nil {
		t.Fatalf("create namespace: %v", err)
	}
	if ns.Name != "team-ai" || ns.Quota.CPU != 32 || ns.Quota.MemoryGi != 128 {
		t.Fatalf("unexpected namespace response: %#v", ns)
	}

	rq, err := client.CoreV1().ResourceQuotas("team-ai").Get(ctx, "knaic-quota", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get quota: %v", err)
	}
	pods := rq.Spec.Hard[corev1.ResourcePods]
	if pods.Cmp(resource.MustParse("200")) != 0 {
		t.Fatalf("pods quota = %s, want 200", pods.String())
	}
	gpu := rq.Spec.Hard[corev1.ResourceName("requests.nvidia.com/gpu")]
	if gpu.Cmp(resource.MustParse("4")) != 0 {
		t.Fatalf("gpu quota = %s, want 4", gpu.String())
	}
}

func TestRoleAndRoleBindingRoundTrip(t *testing.T) {
	ctx := context.Background()
	client := fake.NewSimpleClientset(&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "team-ai"}})
	svc := NewService(client)

	role, err := svc.UpsertRole(ctx, "team-ai", Role{
		Name:      "ml-engineer",
		Namespace: "team-ai",
		Kind:      "Role",
		Rules: []PolicyRule{{
			APIGroups: []string{"serving.kserve.io"},
			Resources: []string{"inferenceservices"},
			Verbs:     []string{"get", "list", "create"},
		}},
	})
	if err != nil {
		t.Fatalf("upsert role: %v", err)
	}
	if role.ID != "team-ai/Role/ml-engineer" {
		t.Fatalf("role id = %q", role.ID)
	}

	binding, err := svc.UpsertRoleBinding(ctx, "team-ai", RoleBinding{
		Name:      "alice-ml",
		Namespace: "team-ai",
		RoleRef:   RoleRef{Kind: "Role", Name: "ml-engineer"},
		Subjects:  []Subject{{Kind: "User", Name: "alice"}},
	})
	if err != nil {
		t.Fatalf("upsert rolebinding: %v", err)
	}
	if binding.ID != "team-ai/alice-ml" || binding.RoleRef.Name != "ml-engineer" {
		t.Fatalf("unexpected binding response: %#v", binding)
	}

	raw, err := client.RbacV1().RoleBindings("team-ai").Get(ctx, "alice-ml", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get raw rolebinding: %v", err)
	}
	if raw.RoleRef.Kind != "Role" || raw.RoleRef.APIGroup != rbacv1.GroupName {
		t.Fatalf("unexpected raw roleRef: %#v", raw.RoleRef)
	}
}
