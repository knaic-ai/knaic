package k8sres

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestResolveInferenceLogTargetPrefersRunningKServePod(t *testing.T) {
	svc := NewService(nil, fake.NewSimpleClientset(
		testPod("team-ml", "qwen-older", map[string]string{
			"serving.kserve.io/inferenceservice": "qwen",
			"serving.kserve.io/component":        "predictor",
		}, corev1.PodPending, "kserve-container"),
		testPod("team-ml", "unrelated", map[string]string{
			"app": "qwen",
		}, corev1.PodRunning, "main"),
		testPod("team-ml", "qwen-newer", map[string]string{
			"serving.kserve.io/inferenceservice": "qwen",
			"serving.kserve.io/component":        "predictor",
		}, corev1.PodRunning, "kserve-container", "queue-proxy"),
	))

	target, err := svc.ResolveInferenceLogTarget(context.Background(), "team-ml", "qwen", "InferenceService")
	if err != nil {
		t.Fatalf("ResolveInferenceLogTarget: %v", err)
	}
	if target.PodName != "qwen-newer" {
		t.Fatalf("PodName = %q, want qwen-newer", target.PodName)
	}
	if got, want := target.Containers, []string{"kserve-container", "queue-proxy"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("Containers = %#v, want %#v", got, want)
	}
}

func TestResolveInferenceLogTargetMatchesLLMInferenceServiceLabel(t *testing.T) {
	svc := NewService(nil, fake.NewSimpleClientset(
		testPod("team-llm", "chat-worker-0", map[string]string{
			"serving.kserve.io/llminferenceservice": "chat",
		}, corev1.PodRunning, "kserve-container"),
	))

	target, err := svc.ResolveInferenceLogTarget(context.Background(), "team-llm", "chat", "LLMInferenceService")
	if err != nil {
		t.Fatalf("ResolveInferenceLogTarget: %v", err)
	}
	if target.PodName != "chat-worker-0" {
		t.Fatalf("PodName = %q, want chat-worker-0", target.PodName)
	}
}

func TestResolveInferenceLogTargetReturnsNotFoundWhenNoPodMatches(t *testing.T) {
	svc := NewService(nil, fake.NewSimpleClientset(
		testPod("team-ml", "other", map[string]string{"app": "other"}, corev1.PodRunning, "main"),
	))

	_, err := svc.ResolveInferenceLogTarget(context.Background(), "team-ml", "qwen", "InferenceService")
	if !apierrors.IsNotFound(err) {
		t.Fatalf("error = %v, want Kubernetes NotFound", err)
	}
}

func testPod(namespace, name string, labels map[string]string, phase corev1.PodPhase, containers ...string) *corev1.Pod {
	podContainers := make([]corev1.Container, 0, len(containers))
	for _, name := range containers {
		podContainers = append(podContainers, corev1.Container{Name: name})
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace,
			Name:      name,
			Labels:    labels,
		},
		Spec: corev1.PodSpec{Containers: podContainers},
		Status: corev1.PodStatus{
			Phase: phase,
		},
	}
}
