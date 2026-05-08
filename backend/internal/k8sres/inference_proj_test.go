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

func TestProjectInferenceServicePreservesEditableFormValues(t *testing.T) {
	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1beta1",
			"kind":       "InferenceService",
			"metadata": map[string]any{
				"name":      "embed",
				"namespace": "team-ml",
				"annotations": map[string]any{
					deploymentModeAnnotation: "RawDeployment",
				},
			},
			"spec": map[string]any{
				"predictor": map[string]any{
					"minReplicas": int64(2),
					"maxReplicas": int64(2),
					"model": map[string]any{
						"runtime":    "vllm",
						"storageUri": "hf://BAAI/bge-large-en-v1.5",
						"resources": map[string]any{
							"requests": map[string]any{"cpu": "1", "memory": "2Gi"},
							"limits":   map[string]any{"cpu": "4", "memory": "8Gi", "nvidia.com/gpu": int64(1)},
						},
						"env":     []any{map[string]any{"name": "LOG_LEVEL", "value": "debug"}},
						"command": []any{"python", "-m", "server"},
						"args":    []any{"--port", "8080"},
					},
				},
			},
		},
	}
	obj.SetCreationTimestamp(metav1.Now())

	p := projectInferenceService(obj)
	if p["cpuRequest"] != "1" || p["cpuLimit"] != "4" {
		t.Fatalf("cpu request/limit = %v/%v, want 1/4", p["cpuRequest"], p["cpuLimit"])
	}
	if p["memoryRequest"] != "2Gi" || p["memoryLimit"] != "8Gi" {
		t.Fatalf("memory request/limit = %v/%v, want 2Gi/8Gi", p["memoryRequest"], p["memoryLimit"])
	}
	if p["deploymentMode"] != "RawDeployment" {
		t.Fatalf("deploymentMode = %v", p["deploymentMode"])
	}
	if env := p["env"].([]map[string]any); len(env) != 1 || env[0]["name"] != "LOG_LEVEL" || env[0]["value"] != "debug" {
		t.Fatalf("env = %#v", p["env"])
	}
	if command := p["command"].([]string); len(command) != 3 || command[0] != "python" {
		t.Fatalf("command = %#v", command)
	}
	if args := p["args"].([]string); len(args) != 2 || args[1] != "8080" {
		t.Fatalf("args = %#v", args)
	}
}

func TestProjectLLMInferenceServicePreservesEditableFormValues(t *testing.T) {
	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": "serving.kserve.io/v1alpha2",
			"kind":       "LLMInferenceService",
			"metadata": map[string]any{
				"name":      "qwen",
				"namespace": "team-ml",
			},
			"spec": map[string]any{
				"model": map[string]any{
					"uri":  "hf://Qwen/Qwen3.5-0.8B",
					"name": "served-qwen",
				},
				"replicas": int64(3),
				"baseRefs": []any{
					map[string]any{"name": "template"},
					map[string]any{"name": "router"},
				},
				"template": map[string]any{
					"containers": []any{
						map[string]any{
							"name":  "main",
							"image": "vllm/vllm-openai:v0.8.0",
							"resources": map[string]any{
								"requests": map[string]any{"cpu": "2", "memory": "4Gi"},
								"limits":   map[string]any{"cpu": "8", "memory": "16Gi"},
							},
							"env":  []any{map[string]any{"name": "HF_HOME", "value": "/models"}},
							"args": []any{"--served-model-name", "served-qwen"},
						},
					},
				},
			},
		},
	}
	obj.SetCreationTimestamp(metav1.Now())

	p := projectLLMInferenceService(obj)
	if p["modelName"] != "served-qwen" {
		t.Fatalf("modelName = %v", p["modelName"])
	}
	if p["containerImage"] != "vllm/vllm-openai:v0.8.0" {
		t.Fatalf("containerImage = %v", p["containerImage"])
	}
	if p["cpuRequest"] != "2" || p["cpuLimit"] != "8" {
		t.Fatalf("cpu request/limit = %v/%v, want 2/8", p["cpuRequest"], p["cpuLimit"])
	}
	refs := p["baseConfigs"].([]string)
	if len(refs) != 2 || refs[0] != "template" || refs[1] != "router" {
		t.Fatalf("baseConfigs = %#v", refs)
	}
	if env := p["env"].([]map[string]any); len(env) != 1 || env[0]["name"] != "HF_HOME" {
		t.Fatalf("env = %#v", p["env"])
	}
	if args := p["args"].([]string); len(args) != 2 || args[1] != "served-qwen" {
		t.Fatalf("args = %#v", args)
	}
}
