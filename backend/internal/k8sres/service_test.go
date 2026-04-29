package k8sres

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic/fake"
)

func TestServiceCreateAndUpdateNamespacedResource(t *testing.T) {
	ctx := context.Background()
	dyn := fake.NewSimpleDynamicClient(runtime.NewScheme())
	svc := NewService(dyn, nil)
	kind, err := Lookup("configmaps")
	if err != nil {
		t.Fatal(err)
	}

	created, err := svc.Create(ctx, kind, "team-ml", map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name": "runtime-config",
		},
		"data": map[string]any{
			"mode": "draft",
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created["name"] != "runtime-config" || created["namespace"] != "team-ml" {
		t.Fatalf("unexpected projection after create: %#v", created)
	}

	_, err = svc.Update(ctx, kind, "team-ml", "runtime-config", map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name": "runtime-config",
		},
		"data": map[string]any{
			"mode": "live",
		},
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	got, err := dyn.Resource(kind.GVR).Namespace("team-ml").Get(ctx, "runtime-config", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get updated object: %v", err)
	}
	mode, _, _ := unstructured.NestedString(got.Object, "data", "mode")
	if mode != "live" {
		t.Fatalf("mode = %q, want live", mode)
	}
}

func TestServiceRejectsMismatchedUpdateName(t *testing.T) {
	ctx := context.Background()
	dyn := fake.NewSimpleDynamicClient(runtime.NewScheme())
	svc := NewService(dyn, nil)
	kind, err := Lookup("configmaps")
	if err != nil {
		t.Fatal(err)
	}

	_, err = svc.Update(ctx, kind, "team-ml", "expected", map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name": "different",
		},
	})
	if err == nil {
		t.Fatal("expected mismatched update name to fail")
	}
}
