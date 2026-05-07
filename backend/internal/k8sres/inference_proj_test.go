package k8sres

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestProjectServingRuntimePreservesEditableFormValues(t *testing.T) {
	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1alpha1",
			"kind":       "ServingRuntime",
			"metadata": map[string]any{
				"name":      "custom-runtime",
				"namespace": "team-ml",
				"labels": map[string]any{
					"knaic.io/runtime": "sglang",
				},
			},
			"spec": map[string]any{
				"supportedModelFormats": []any{
					map[string]any{"name": "huggingface", "autoSelect": true},
				},
				"containers": []any{
					map[string]any{
						"name":  "kserve-container",
						"image": "registry.example.com/ml/runtime:latest",
						"args":  []any{"--port", "8080"},
						"resources": map[string]any{
							"requests": map[string]any{
								"cpu":               "1",
								"memory":            "2Gi",
								"nvidia.com/gpu":    int64(1),
								"nvidia.com/gpumem": int64(8192),
							},
							"limits": map[string]any{
								"cpu":               "4",
								"memory":            "16Gi",
								"nvidia.com/gpu":    int64(1),
								"nvidia.com/gpumem": int64(8192),
							},
						},
						"securityContext": map[string]any{
							"allowPrivilegeEscalation": false,
							"runAsUser":                int64(1000),
						},
					},
				},
			},
		},
	}
	obj.SetCreationTimestamp(metav1.Now())

	p := projectServingRuntime(obj)
	if p["runtime"] != "sglang" {
		t.Fatalf("runtime = %v, want sglang", p["runtime"])
	}
	if p["cpuRequest"] != "1" {
		t.Fatalf("cpuRequest = %v, want 1", p["cpuRequest"])
	}
	if p["cpuLimit"] != "4" {
		t.Fatalf("cpuLimit = %v, want 4", p["cpuLimit"])
	}
	if p["memoryRequest"] != "2Gi" {
		t.Fatalf("memoryRequest = %v, want 2Gi", p["memoryRequest"])
	}
	if p["memoryLimit"] != "16Gi" {
		t.Fatalf("memoryLimit = %v, want 16Gi", p["memoryLimit"])
	}
	if got := p["resources"].(map[string]any)["cpu"]; got != "1" {
		t.Fatalf("resources.cpu = %v, want request value 1", got)
	}
	if _, ok := p["securityContext"].(map[string]any); !ok {
		t.Fatalf("securityContext not projected: %#v", p["securityContext"])
	}
}
