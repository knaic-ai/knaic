package inference

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clientgofake "k8s.io/client-go/kubernetes/fake"
	discoveryfake "k8s.io/client-go/discovery/fake"
	clientgotesting "k8s.io/client-go/testing"
)

// newTestService builds a Service backed by an empty fake dynamic client
// scheme — all CRDs are unregistered, which means objects round-trip as
// plain unstructured maps and we can inspect what the Service would have
// PUT/POSTed to the apiserver.
func newTestService() *Service {
	return New(nil, dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()), nil)
}

func TestCreateLLMInferenceServiceUsesCurrentKServeSchema(t *testing.T) {
	svc := newTestService()

	obj, err := svc.CreateService(context.Background(), "team-ml", CreateServiceRequest{
		Name:          "qwen",
		Kind:          "LLMInferenceService",
		Runtime:       "vllm",
		ModelURI:      "hf://Qwen/Qwen3.5-0.8B",
		Replicas:      2,
		CPURequest:    "1",
		CPULimit:      "4",
		MemoryRequest: "2Gi",
		MemoryLimit:   "16Gi",
		GPUValues:     map[string]int64{"nvidia.com/gpu": 1},
		Env:           []EnvVar{{Name: "HF_HOME", Value: "/models"}},
		Command:       []string{"vllm"},
		Args:          []string{"serve", "/mnt/models"},
	})
	if err != nil {
		t.Fatalf("CreateService: %v", err)
	}

	if got := obj.GetAPIVersion(); got != "serving.kserve.io/v1alpha2" {
		t.Fatalf("apiVersion = %q, want serving.kserve.io/v1alpha2", got)
	}
	if _, ok, _ := unstructured.NestedInt64(obj.Object, "spec", "minReplicas"); ok {
		t.Fatalf("spec.minReplicas should not be emitted for LLMInferenceService")
	}
	if _, ok, _ := unstructured.NestedInt64(obj.Object, "spec", "maxReplicas"); ok {
		t.Fatalf("spec.maxReplicas should not be emitted for LLMInferenceService")
	}
	if _, ok, _ := unstructured.NestedMap(obj.Object, "spec", "runtimeRef"); ok {
		t.Fatalf("spec.runtimeRef should not be emitted for LLMInferenceService")
	}
	if _, ok, _ := unstructured.NestedMap(obj.Object, "spec", "model", "resources"); ok {
		t.Fatalf("spec.model.resources should not be emitted for LLMInferenceService")
	}
	if _, ok, _ := unstructured.NestedSlice(obj.Object, "spec", "model", "env"); ok {
		t.Fatalf("spec.model.env should not be emitted for LLMInferenceService")
	}

	replicas, ok, _ := unstructured.NestedInt64(obj.Object, "spec", "replicas")
	if !ok || replicas != 2 {
		t.Fatalf("spec.replicas = %d, ok=%v; want 2", replicas, ok)
	}
	uri, _, _ := unstructured.NestedString(obj.Object, "spec", "model", "uri")
	if uri != "hf://Qwen/Qwen3.5-0.8B" {
		t.Fatalf("spec.model.uri = %q", uri)
	}

	containers, ok, _ := unstructured.NestedSlice(obj.Object, "spec", "template", "containers")
	if !ok || len(containers) != 1 {
		t.Fatalf("template containers length = %d, ok=%v; want 1", len(containers), ok)
	}
	container, ok := containers[0].(map[string]any)
	if !ok {
		t.Fatalf("template container has type %T, want map[string]any", containers[0])
	}
	name, _, _ := unstructured.NestedString(container, "name")
	if name != "main" {
		t.Fatalf("container name = %q, want main", name)
	}
	cpu, _, _ := unstructured.NestedString(container, "resources", "requests", "cpu")
	if cpu != "1" {
		t.Fatalf("request cpu = %q, want 1", cpu)
	}
	mem, _, _ := unstructured.NestedString(container, "resources", "limits", "memory")
	if mem != "16Gi" {
		t.Fatalf("limit memory = %q, want 16Gi", mem)
	}
	gpu, _, _ := unstructured.NestedInt64(container, "resources", "limits", "nvidia.com/gpu")
	if gpu != 1 {
		t.Fatalf("gpu limit = %d, want 1", gpu)
	}
	env, ok, _ := unstructured.NestedSlice(container, "env")
	if !ok || len(env) != 1 {
		t.Fatalf("env length = %d, ok=%v; want 1", len(env), ok)
	}
	command, _, _ := unstructured.NestedStringSlice(container, "command")
	if len(command) != 1 || command[0] != "vllm" {
		t.Fatalf("command = %#v", command)
	}
	args, _, _ := unstructured.NestedStringSlice(container, "args")
	if len(args) != 2 || args[0] != "serve" || args[1] != "/mnt/models" {
		t.Fatalf("args = %#v", args)
	}
}

// InferenceService (v1beta1) is a different shape from the LLM kind — the
// model goes under spec.predictor.model with a runtime ref and resources
// attached to the model itself. Min/max replicas live on the predictor.
func TestCreateInferenceServiceUsesV1Beta1PredictorShape(t *testing.T) {
	svc := newTestService()
	obj, err := svc.CreateService(context.Background(), "team-ml", CreateServiceRequest{
		Name:          "qwen-classic",
		Kind:          "InferenceService",
		Runtime:       "vllm",
		ModelURI:      "hf://Qwen/Qwen3.5-7B-Instruct",
		Replicas:      3,
		CPURequest:    "8",
		CPULimit:      "8",
		MemoryRequest: "64Gi",
		MemoryLimit:   "64Gi",
		GPUValues: map[string]int64{
			"nvidia.com/gpualloc": 1,
			"nvidia.com/gpucores": 80,
			"nvidia.com/gpumem":   24000,
		},
		Env:     []EnvVar{{Name: "VLLM_LOGGING_LEVEL", Value: "INFO"}},
		Command: []string{"python", "-m", "vllm.entrypoints.openai.api_server"},
		Args:    []string{"--max-model-len", "32768"},
	})
	if err != nil {
		t.Fatalf("CreateService: %v", err)
	}

	if got := obj.GetAPIVersion(); got != "serving.kserve.io/v1beta1" {
		t.Fatalf("apiVersion = %q, want serving.kserve.io/v1beta1", got)
	}
	if got := obj.GetKind(); got != "InferenceService" {
		t.Fatalf("kind = %q, want InferenceService", got)
	}
	if _, ok, _ := unstructured.NestedFieldNoCopy(obj.Object, "spec", "template"); ok {
		t.Fatalf("spec.template is LLM-only and must not appear on InferenceService")
	}
	if _, ok, _ := unstructured.NestedFieldNoCopy(obj.Object, "spec", "baseRefs"); ok {
		t.Fatalf("spec.baseRefs is LLM-only and must not appear on InferenceService")
	}
	if _, ok, _ := unstructured.NestedInt64(obj.Object, "spec", "replicas"); ok {
		t.Fatalf("spec.replicas is LLM-only; v1beta1 uses predictor.{min,max}Replicas")
	}

	min, _, _ := unstructured.NestedInt64(obj.Object, "spec", "predictor", "minReplicas")
	max, _, _ := unstructured.NestedInt64(obj.Object, "spec", "predictor", "maxReplicas")
	if min != 3 || max != 3 {
		t.Fatalf("predictor min/maxReplicas = %d/%d, want 3/3", min, max)
	}
	model, ok, _ := unstructured.NestedMap(obj.Object, "spec", "predictor", "model")
	if !ok {
		t.Fatalf("spec.predictor.model missing")
	}
	if v, _, _ := unstructured.NestedString(model, "runtime"); v != "vllm" {
		t.Fatalf("model.runtime = %q, want vllm", v)
	}
	if v, _, _ := unstructured.NestedString(model, "storageUri"); v != "hf://Qwen/Qwen3.5-7B-Instruct" {
		t.Fatalf("model.storageUri = %q", v)
	}
	if v, _, _ := unstructured.NestedString(model, "modelFormat", "name"); v != "huggingface" {
		t.Fatalf("model.modelFormat.name = %q, want huggingface", v)
	}
	cpuReq, _, _ := unstructured.NestedString(model, "resources", "requests", "cpu")
	if cpuReq != "8" {
		t.Fatalf("model.resources.requests.cpu = %q, want 8", cpuReq)
	}
	// All three HAMi keys must round-trip into both requests and limits.
	for _, key := range []string{"nvidia.com/gpualloc", "nvidia.com/gpucores", "nvidia.com/gpumem"} {
		if _, ok, _ := unstructured.NestedFieldNoCopy(model, "resources", "requests", key); !ok {
			t.Fatalf("requests.%s missing", key)
		}
		if _, ok, _ := unstructured.NestedFieldNoCopy(model, "resources", "limits", key); !ok {
			t.Fatalf("limits.%s missing", key)
		}
	}
	if cmd, _, _ := unstructured.NestedStringSlice(model, "command"); len(cmd) != 3 || cmd[0] != "python" {
		t.Fatalf("model.command = %#v", cmd)
	}
	if args, _, _ := unstructured.NestedStringSlice(model, "args"); len(args) != 2 || args[1] != "32768" {
		t.Fatalf("model.args = %#v", args)
	}

	labels := obj.GetLabels()
	if labels["knaic.io/managed"] != "true" || labels["knaic.io/component"] != "inference" {
		t.Fatalf("expected knaic ownership labels, got %#v", labels)
	}
}

// LLMInferenceService picks up template/router defaults from the configs
// listed in spec.baseRefs. The form passes a list of names; the backend
// must convert each to {name: ...} entries and emit the array.
func TestCreateLLMInferenceServiceWithBaseRefs(t *testing.T) {
	svc := newTestService()
	obj, err := svc.CreateService(context.Background(), "team-ml", CreateServiceRequest{
		Name:        "qwen-llm",
		Kind:        "LLMInferenceService",
		ModelURI:    "hf://Qwen/Qwen3.5-0.8B",
		ModelName:   "qwen3-5",
		Replicas:    1,
		BaseConfigs: []string{"kserve-config-llm-template", "kserve-config-llm-scheduler"},
	})
	if err != nil {
		t.Fatalf("CreateService: %v", err)
	}

	refs, ok, _ := unstructured.NestedSlice(obj.Object, "spec", "baseRefs")
	if !ok || len(refs) != 2 {
		t.Fatalf("spec.baseRefs len = %d, ok=%v; want 2", len(refs), ok)
	}
	wantNames := map[string]bool{"kserve-config-llm-template": true, "kserve-config-llm-scheduler": true}
	for _, raw := range refs {
		m, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("baseRefs[i] = %T, want map[string]any", raw)
		}
		name, _, _ := unstructured.NestedString(m, "name")
		if !wantNames[name] {
			t.Fatalf("unexpected baseRefs name %q", name)
		}
		delete(wantNames, name)
	}
	if name, _, _ := unstructured.NestedString(obj.Object, "spec", "model", "name"); name != "qwen3-5" {
		t.Fatalf("spec.model.name = %q, want qwen3-5", name)
	}
}

// When the user picks a base config but doesn't override anything in the
// container, the backend must NOT emit spec.template.containers — an empty
// container would shadow the chosen base config's template.
func TestCreateLLMInferenceServiceOmitsTemplateWhenNoOverrides(t *testing.T) {
	svc := newTestService()
	obj, err := svc.CreateService(context.Background(), "team-ml", CreateServiceRequest{
		Name:        "qwen-bare",
		Kind:        "LLMInferenceService",
		ModelURI:    "hf://Qwen/Qwen3.5-0.8B",
		Replicas:    1,
		BaseConfigs: []string{"kserve-config-llm-template"},
	})
	if err != nil {
		t.Fatalf("CreateService: %v", err)
	}
	if _, ok, _ := unstructured.NestedFieldNoCopy(obj.Object, "spec", "template"); ok {
		t.Fatalf("spec.template should be omitted when no container fields are set; emitting it would shadow base config defaults")
	}
}

// LLMInferenceService with HAMi-style accelerator keys: every resource key
// (cpu/memory + non-cpu/non-memory) must reach both requests and limits.
func TestCreateLLMInferenceServicePreservesHAMiKeys(t *testing.T) {
	svc := newTestService()
	obj, err := svc.CreateService(context.Background(), "team-ml", CreateServiceRequest{
		Name:           "qwen-hami",
		Kind:           "LLMInferenceService",
		ModelURI:       "hf://Qwen/Qwen3.5-0.8B",
		Replicas:       1,
		ContainerImage: "vllm/vllm-openai:v0.7.2",
		CPURequest:     "4",
		CPULimit:       "8",
		MemoryRequest:  "16Gi",
		MemoryLimit:    "32Gi",
		GPUValues: map[string]int64{
			"nvidia.com/gpualloc": 1,
			"nvidia.com/gpucores": 80,
			"nvidia.com/gpumem":   24000,
		},
	})
	if err != nil {
		t.Fatalf("CreateService: %v", err)
	}
	containers, ok, _ := unstructured.NestedSlice(obj.Object, "spec", "template", "containers")
	if !ok || len(containers) != 1 {
		t.Fatalf("template containers length = %d, ok=%v", len(containers), ok)
	}
	c := containers[0].(map[string]any)
	if img, _, _ := unstructured.NestedString(c, "image"); img != "vllm/vllm-openai:v0.7.2" {
		t.Fatalf("container image = %q", img)
	}
	for _, key := range []string{"nvidia.com/gpualloc", "nvidia.com/gpucores", "nvidia.com/gpumem"} {
		if _, ok, _ := unstructured.NestedFieldNoCopy(c, "resources", "requests", key); !ok {
			t.Fatalf("container.resources.requests.%s missing", key)
		}
		if _, ok, _ := unstructured.NestedFieldNoCopy(c, "resources", "limits", key); !ok {
			t.Fatalf("container.resources.limits.%s missing", key)
		}
	}
	if cpu, _, _ := unstructured.NestedString(c, "resources", "requests", "cpu"); cpu != "4" {
		t.Fatalf("requests.cpu = %q, want 4", cpu)
	}
	if mem, _, _ := unstructured.NestedString(c, "resources", "limits", "memory"); mem != "32Gi" {
		t.Fatalf("limits.memory = %q, want 32Gi", mem)
	}
}

func TestCreateRuntimeIncludesDefaultSecurityContext(t *testing.T) {
	svc := newTestService()

	obj, err := svc.CreateRuntime(context.Background(), "team-ml", CreateRuntimeRequest{
		Name:          "vllm-runtime",
		Image:         "vllm/vllm-openai:v0.7.2",
		Runtime:       "vllm",
		CPURequest:    "1",
		MemoryRequest: "2Gi",
	})
	if err != nil {
		t.Fatalf("CreateRuntime: %v", err)
	}

	containers, ok, _ := unstructured.NestedSlice(obj.Object, "spec", "containers")
	if !ok || len(containers) != 1 {
		t.Fatalf("containers length = %d, ok=%v; want 1", len(containers), ok)
	}
	container, ok := containers[0].(map[string]any)
	if !ok {
		t.Fatalf("container has type %T, want map[string]any", containers[0])
	}

	allowPrivilegeEscalation, ok, _ := unstructured.NestedBool(container, "securityContext", "allowPrivilegeEscalation")
	if !ok || allowPrivilegeEscalation {
		t.Fatalf("allowPrivilegeEscalation = %v, ok=%v; want false", allowPrivilegeEscalation, ok)
	}
	privileged, ok, _ := unstructured.NestedBool(container, "securityContext", "privileged")
	if !ok || privileged {
		t.Fatalf("privileged = %v, ok=%v; want false", privileged, ok)
	}
	runAsNonRoot, ok, _ := unstructured.NestedBool(container, "securityContext", "runAsNonRoot")
	if !ok || !runAsNonRoot {
		t.Fatalf("runAsNonRoot = %v, ok=%v; want true", runAsNonRoot, ok)
	}
	runAsUser, ok, _ := unstructured.NestedInt64(container, "securityContext", "runAsUser")
	if !ok || runAsUser != 1000 {
		t.Fatalf("runAsUser = %d, ok=%v; want 1000", runAsUser, ok)
	}
	drops, ok, _ := unstructured.NestedStringSlice(container, "securityContext", "capabilities", "drop")
	if !ok || len(drops) != 1 || drops[0] != "ALL" {
		t.Fatalf("capabilities.drop = %#v, ok=%v; want [ALL]", drops, ok)
	}
	seccompType, ok, _ := unstructured.NestedString(container, "securityContext", "seccompProfile", "type")
	if !ok || seccompType != "RuntimeDefault" {
		t.Fatalf("seccompProfile.type = %q, ok=%v; want RuntimeDefault", seccompType, ok)
	}
}

// CreateRuntime must surface every HAMi-style accelerator key in both
// requests and limits (the legacy single GPULimit fallback only fires when
// GPUValues is empty).
func TestCreateRuntimePreservesHAMiKeys(t *testing.T) {
	svc := newTestService()
	obj, err := svc.CreateRuntime(context.Background(), "team-ml", CreateRuntimeRequest{
		Name:          "hami-runtime",
		Image:         "vllm/vllm-openai:v0.7.2",
		Runtime:       "vllm",
		CPURequest:    "8",
		CPULimit:      "8",
		MemoryRequest: "64Gi",
		MemoryLimit:   "64Gi",
		GPUValues: map[string]int64{
			"nvidia.com/gpualloc": 1,
			"nvidia.com/gpucores": 80,
			"nvidia.com/gpumem":   24000,
		},
		// Legacy GPULimit must be IGNORED when GPUValues is non-empty so we
		// don't double-stamp nvidia.com/gpu next to HAMi keys.
		GPULimit: 4,
	})
	if err != nil {
		t.Fatalf("CreateRuntime: %v", err)
	}
	containers, ok, _ := unstructured.NestedSlice(obj.Object, "spec", "containers")
	if !ok || len(containers) != 1 {
		t.Fatalf("containers length = %d", len(containers))
	}
	c := containers[0].(map[string]any)
	if _, ok, _ := unstructured.NestedFieldNoCopy(c, "resources", "limits", "nvidia.com/gpu"); ok {
		t.Fatalf("nvidia.com/gpu must not appear when GPUValues is provided — that's the legacy-only fallback")
	}
	for _, key := range []string{"nvidia.com/gpualloc", "nvidia.com/gpucores", "nvidia.com/gpumem"} {
		if _, ok, _ := unstructured.NestedFieldNoCopy(c, "resources", "requests", key); !ok {
			t.Fatalf("requests.%s missing", key)
		}
		if _, ok, _ := unstructured.NestedFieldNoCopy(c, "resources", "limits", key); !ok {
			t.Fatalf("limits.%s missing", key)
		}
	}
}

// CreateRuntime falls back to GPULimit when no GPUValues map is supplied —
// this is the form's "Old single GPU count" code path that we still
// support for backward compat.
func TestCreateRuntimeLegacyGPULimitFallback(t *testing.T) {
	svc := newTestService()
	obj, err := svc.CreateRuntime(context.Background(), "team-ml", CreateRuntimeRequest{
		Name:          "legacy-runtime",
		Image:         "vllm/vllm-openai:v0.7.2",
		Runtime:       "vllm",
		CPURequest:    "8",
		MemoryRequest: "64Gi",
		GPULimit:      2,
	})
	if err != nil {
		t.Fatalf("CreateRuntime: %v", err)
	}
	containers, _, _ := unstructured.NestedSlice(obj.Object, "spec", "containers")
	c := containers[0].(map[string]any)
	gpu, ok, _ := unstructured.NestedInt64(c, "resources", "limits", "nvidia.com/gpu")
	if !ok || gpu != 2 {
		t.Fatalf("limits.nvidia.com/gpu = %d, ok=%v; want 2", gpu, ok)
	}
}

// UpdateRuntime must rewrite the spec from the form values while keeping
// resourceVersion, uid and any caller-supplied non-knaic labels — those
// come from a prior GET on the dynamic client.
func TestUpdateRuntimePreservesIdentity(t *testing.T) {
	svc := newTestService()
	created, err := svc.CreateRuntime(context.Background(), "team-ml", CreateRuntimeRequest{
		Name:          "vllm-runtime",
		Image:         "vllm/vllm-openai:v0.7.2",
		Runtime:       "vllm",
		CPURequest:    "8",
		MemoryRequest: "64Gi",
	})
	if err != nil {
		t.Fatalf("CreateRuntime: %v", err)
	}
	// Stamp some external metadata that the GET → Update path should keep.
	cur, err := svc.dyn.Resource(gvrServingRuntime).Namespace("team-ml").Get(context.Background(), "vllm-runtime", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	cur.SetUID("uid-1234")
	cur.SetResourceVersion("99")
	annos := cur.GetAnnotations()
	if annos == nil {
		annos = map[string]string{}
	}
	annos["external.example.com/managed-by"] = "external-system"
	cur.SetAnnotations(annos)
	labels := cur.GetLabels()
	labels["app.kubernetes.io/instance"] = "external"
	cur.SetLabels(labels)
	if _, err := svc.dyn.Resource(gvrServingRuntime).Namespace("team-ml").Update(context.Background(), cur, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("seed update: %v", err)
	}
	_ = created // sanity

	updated, err := svc.UpdateRuntime(context.Background(), "team-ml", "vllm-runtime", CreateRuntimeRequest{
		Name:          "vllm-runtime",
		Image:         "vllm/vllm-openai:v0.8.0", // image bump — should land in spec
		Runtime:       "vllm",
		CPURequest:    "16",
		MemoryRequest: "128Gi",
	})
	if err != nil {
		t.Fatalf("UpdateRuntime: %v", err)
	}
	if updated.GetUID() != "uid-1234" {
		t.Fatalf("uid = %q, want preserved 'uid-1234'", updated.GetUID())
	}
	if updated.GetAnnotations()["external.example.com/managed-by"] != "external-system" {
		t.Fatalf("external annotation lost on update")
	}
	gotLabels := updated.GetLabels()
	if gotLabels["app.kubernetes.io/instance"] != "external" {
		t.Fatalf("external label lost on update")
	}
	if gotLabels["knaic.io/managed"] != "true" {
		t.Fatalf("knaic.io/managed label not (re)applied on update")
	}
	containers, _, _ := unstructured.NestedSlice(updated.Object, "spec", "containers")
	c := containers[0].(map[string]any)
	if img, _, _ := unstructured.NestedString(c, "image"); img != "vllm/vllm-openai:v0.8.0" {
		t.Fatalf("spec.containers[0].image = %q, want bumped value", img)
	}
}

// SetStopped flips the KServe stop annotation in both directions and
// preserves any caller-supplied annotations.
func TestSetStoppedTogglesAnnotation(t *testing.T) {
	svc := newTestService()
	if _, err := svc.CreateService(context.Background(), "team-ml", CreateServiceRequest{
		Name:          "qwen-toggle",
		Kind:          "InferenceService",
		Runtime:       "vllm",
		ModelURI:      "hf://Qwen/Qwen3.5-7B",
		Replicas:      1,
		CPURequest:    "1",
		MemoryRequest: "2Gi",
	}); err != nil {
		t.Fatalf("CreateService: %v", err)
	}
	// Pre-stamp an unrelated annotation; SetStopped must not nuke it.
	cur, _ := svc.dyn.Resource(gvrInferenceService).Namespace("team-ml").Get(context.Background(), "qwen-toggle", metav1.GetOptions{})
	cur.SetAnnotations(map[string]string{"kept.example.com/foo": "bar"})
	_, _ = svc.dyn.Resource(gvrInferenceService).Namespace("team-ml").Update(context.Background(), cur, metav1.UpdateOptions{})

	stopped, err := svc.SetStopped(context.Background(), "team-ml", "qwen-toggle", "InferenceService", true)
	if err != nil {
		t.Fatalf("SetStopped(true): %v", err)
	}
	if v := stopped.GetAnnotations()[stopAnnotation]; v != "true" {
		t.Fatalf("after stop: %s = %q, want true", stopAnnotation, v)
	}
	if stopped.GetAnnotations()["kept.example.com/foo"] != "bar" {
		t.Fatalf("unrelated annotation dropped on stop")
	}

	started, err := svc.SetStopped(context.Background(), "team-ml", "qwen-toggle", "InferenceService", false)
	if err != nil {
		t.Fatalf("SetStopped(false): %v", err)
	}
	if _, present := started.GetAnnotations()[stopAnnotation]; present {
		t.Fatalf("after start: %s annotation should be deleted", stopAnnotation)
	}
	if started.GetAnnotations()["kept.example.com/foo"] != "bar" {
		t.Fatalf("unrelated annotation dropped on start")
	}
}

func TestSetStoppedRejectsUnknownKind(t *testing.T) {
	svc := newTestService()
	_, err := svc.SetStopped(context.Background(), "team-ml", "doesnt-matter", "Whatever", true)
	if err == nil {
		t.Fatalf("expected error for unknown kind")
	}
}

// CreateService(InferenceService) stamps the
// `serving.kserve.io/deploymentMode` annotation when DeploymentMode is set.
func TestCreateInferenceServiceStampsDeploymentModeAnnotation(t *testing.T) {
	svc := newTestService()
	obj, err := svc.CreateService(context.Background(), "team-ml", CreateServiceRequest{
		Name:           "qwen-mode",
		Kind:           "InferenceService",
		Runtime:        "vllm",
		ModelURI:       "hf://Qwen/Qwen3.5-7B",
		Replicas:       1,
		CPURequest:     "1",
		MemoryRequest:  "2Gi",
		DeploymentMode: "Standard",
	})
	if err != nil {
		t.Fatalf("CreateService: %v", err)
	}
	if got := obj.GetAnnotations()[deploymentModeAnnotation]; got != "Standard" {
		t.Fatalf("annotation %s = %q, want Standard", deploymentModeAnnotation, got)
	}
}

// When DeploymentMode is empty the annotation must NOT be emitted — KServe
// then falls back to its configmap-defined cluster default.
func TestCreateInferenceServiceOmitsDeploymentModeWhenUnset(t *testing.T) {
	svc := newTestService()
	obj, err := svc.CreateService(context.Background(), "team-ml", CreateServiceRequest{
		Name:          "qwen-default",
		Kind:          "InferenceService",
		Runtime:       "vllm",
		ModelURI:      "hf://Qwen/Qwen3.5-7B",
		Replicas:      1,
		CPURequest:    "1",
		MemoryRequest: "2Gi",
	})
	if err != nil {
		t.Fatalf("CreateService: %v", err)
	}
	if _, present := obj.GetAnnotations()[deploymentModeAnnotation]; present {
		t.Fatalf("annotation %s should be absent when DeploymentMode is empty", deploymentModeAnnotation)
	}
}

// fakeDiscoveryWithGroups builds a discovery client that reports the given
// groupVersions as installed. Anything else returns NotFound.
func fakeDiscoveryWithGroups(groupVersions ...string) *discoveryfake.FakeDiscovery {
	resources := make([]*metav1.APIResourceList, 0, len(groupVersions))
	for _, gv := range groupVersions {
		resources = append(resources, &metav1.APIResourceList{
			GroupVersion: gv,
			APIResources: []metav1.APIResource{{Name: "probe", Namespaced: false, Kind: "Probe"}},
		})
	}
	d := &discoveryfake.FakeDiscovery{Fake: &clientgotesting.Fake{}}
	d.Resources = resources
	return d
}

// Bare Service with no typed/discovery wired must still return a usable
// list of modes — the form has to render even on offline / dev runs.
func TestListDeploymentModesFallback(t *testing.T) {
	svc := newTestService()
	info, err := svc.ListDeploymentModes(context.Background())
	if err != nil {
		t.Fatalf("ListDeploymentModes: %v", err)
	}
	if info.Default != "Standard" {
		t.Fatalf("default = %q, want Standard", info.Default)
	}
	if !contains(info.Modes, "Standard") || !contains(info.Modes, "RawDeployment") {
		t.Fatalf("modes = %#v, missing Standard / RawDeployment", info.Modes)
	}
	if contains(info.Modes, "Serverless") {
		t.Fatalf("Serverless must NOT appear without Knative discovery")
	}
}

// When discovery reports Knative, the modes list grows to include Serverless.
func TestListDeploymentModesIncludesServerlessWhenKnativePresent(t *testing.T) {
	svc := New(nil,
		dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()),
		fakeDiscoveryWithGroups("serving.knative.dev/v1"),
	)
	info, _ := svc.ListDeploymentModes(context.Background())
	if !contains(info.Modes, "Serverless") {
		t.Fatalf("modes = %#v, expected Serverless", info.Modes)
	}
}

// The configmap's "Knative" alias must be normalised to "Serverless" when
// surfaced as the default mode.
func TestListDeploymentModesReadsConfigMapDefault(t *testing.T) {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: kserveConfigMap, Namespace: kserveConfigNamespace},
		Data: map[string]string{
			"deploy": `{"defaultDeploymentMode":"Knative"}`,
		},
	}
	typed := clientgofake.NewSimpleClientset(cm)
	svc := New(typed,
		dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()),
		fakeDiscoveryWithGroups("serving.knative.dev/v1"),
	)
	info, err := svc.ListDeploymentModes(context.Background())
	if err != nil {
		t.Fatalf("ListDeploymentModes: %v", err)
	}
	if info.Default != "Serverless" {
		t.Fatalf("default = %q, want Serverless (Knative alias should normalise)", info.Default)
	}
}

// Configmap can introduce an admin-enabled mode (e.g. ModelMesh) that the
// service didn't ship in its base list — surface it so the picker offers it.
func TestListDeploymentModesAddsConfigMapModeWhenUnknown(t *testing.T) {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: kserveConfigMap, Namespace: kserveConfigNamespace},
		Data: map[string]string{
			"deploy": `{"defaultDeploymentMode":"ModelMesh"}`,
		},
	}
	typed := clientgofake.NewSimpleClientset(cm)
	svc := New(typed, dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()), nil)
	info, _ := svc.ListDeploymentModes(context.Background())
	if !contains(info.Modes, "ModelMesh") {
		t.Fatalf("modes = %#v, expected ModelMesh from configmap", info.Modes)
	}
	if info.Default != "ModelMesh" {
		t.Fatalf("default = %q, want ModelMesh", info.Default)
	}
}
