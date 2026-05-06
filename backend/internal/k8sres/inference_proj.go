package k8sres

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// projectServingRuntime mirrors data/inference.ts ServingRuntime on the
// frontend. We pull container[0] for image / args and surface the supported
// model formats as a simple []string.
func projectServingRuntime(o *unstructured.Unstructured) Projection {
	p := base(o)
	rawFmts, _, _ := unstructured.NestedSlice(o.Object, "spec", "supportedModelFormats")
	fmts := make([]string, 0, len(rawFmts))
	for _, raw := range rawFmts {
		if m, ok := raw.(map[string]any); ok {
			if name, _, _ := unstructured.NestedString(m, "name"); name != "" {
				fmts = append(fmts, name)
			}
		}
	}
	c, _ := nestedFirstContainer(o.Object, "spec", "containers")
	var image string
	var defaultArgs []string
	resources := map[string]any{"cpu": "", "memory": "", "gpu": int64(0)}
	var gpuValues map[string]int64
	if c != nil {
		image, _, _ = unstructured.NestedString(c, "image")
		args, _, _ := unstructured.NestedStringSlice(c, "args")
		defaultArgs = args
		cpu, mem, gpu, gpuMap := containerResources(c)
		resources["cpu"] = cpu
		resources["memory"] = mem
		if gpu > 0 {
			resources["gpu"] = gpu
		}
		gpuValues = gpuMap
	}
	// Best-effort runtime classifier — matches the prototype's vllm/sglang/custom union.
	runtime := "custom"
	switch {
	case containsCI(image, "vllm"):
		runtime = "vllm"
	case containsCI(image, "sglang"):
		runtime = "sglang"
	}
	p["runtime"] = runtime
	p["image"] = image
	p["supportedModelFormats"] = fmts
	p["defaultArgs"] = defaultArgs
	p["resources"] = resources
	if len(gpuValues) > 0 {
		p["gpuValues"] = gpuValues
	}
	p["builtin"] = false
	return p
}

// projectInferenceService matches the v1beta1 KServe shape.
func projectInferenceService(o *unstructured.Unstructured) Projection {
	p := base(o)
	stopped := isStopped(o)
	min, _, _ := unstructured.NestedInt64(o.Object, "spec", "predictor", "minReplicas")
	if min == 0 && !stopped {
		min = 1
	}
	max, _, _ := unstructured.NestedInt64(o.Object, "spec", "predictor", "maxReplicas")
	if max == 0 {
		max = min
	}
	model, _, _ := unstructured.NestedMap(o.Object, "spec", "predictor", "model")
	runtime, _, _ := unstructured.NestedString(model, "runtime")
	storageURI, _, _ := unstructured.NestedString(model, "storageUri")

	// Resources can sit on .model or on the predictor's pod template — try
	// .model first (the form-based form we emit) and fall back to the first
	// container of the predictor's spec.
	cpu, mem, gpu, gpuValues := containerResources(model)
	if cpu == "" {
		if pod, ok, _ := unstructured.NestedMap(o.Object, "spec", "predictor"); ok {
			if c, found := nestedFirstContainer(pod, "containers"); found {
				cpu, mem, gpu, gpuValues = containerResources(c)
			}
		}
	}

	endpoint, _, _ := unstructured.NestedString(o.Object, "status", "url")

	p["kind"] = "InferenceService"
	p["runtime"] = runtime
	p["modelUri"] = storageURI
	p["minReplicas"] = min
	p["maxReplicas"] = max
	p["resources"] = map[string]any{"cpu": cpu, "memory": mem, "gpu": gpu}
	if len(gpuValues) > 0 {
		p["gpuValues"] = gpuValues
	}
	p["endpoint"] = endpoint
	p["status"] = inferenceStatus(o, stopped)
	p["stopped"] = stopped
	p["deploymentMode"] = deploymentMode(o)
	return p
}

func projectLLMInferenceService(o *unstructured.Unstructured) Projection {
	p := base(o)
	stopped := isStopped(o)
	storageURI, _, _ := unstructured.NestedString(o.Object, "spec", "model", "uri")
	if storageURI == "" {
		// Some KServe LLM API revisions nest under .spec.model.storageUri.
		storageURI, _, _ = unstructured.NestedString(o.Object, "spec", "model", "storageUri")
	}
	runtime, _, _ := unstructured.NestedString(o.Object, "spec", "runtime")
	if runtime == "" {
		runtime, _, _ = unstructured.NestedString(o.Object, "spec", "runtimeRef", "name")
	}
	min, _, _ := unstructured.NestedInt64(o.Object, "spec", "minReplicas")
	if min == 0 && !stopped {
		min = 1
	}
	max, _, _ := unstructured.NestedInt64(o.Object, "spec", "maxReplicas")
	if max == 0 {
		max = min
	}
	cpu, mem, gpu, gpuValues := "", "", int64(0), map[string]int64(nil)
	if model, ok, _ := unstructured.NestedMap(o.Object, "spec", "model"); ok {
		cpu, mem, gpu, gpuValues = containerResources(model)
	}
	endpoint, _, _ := unstructured.NestedString(o.Object, "status", "url")
	p["kind"] = "LLMInferenceService"
	p["runtime"] = runtime
	p["modelUri"] = storageURI
	p["minReplicas"] = min
	p["maxReplicas"] = max
	p["resources"] = map[string]any{"cpu": cpu, "memory": mem, "gpu": gpu}
	if len(gpuValues) > 0 {
		p["gpuValues"] = gpuValues
	}
	p["endpoint"] = endpoint
	p["status"] = inferenceStatus(o, stopped)
	p["stopped"] = stopped
	p["deploymentMode"] = deploymentMode(o)
	return p
}

// containerResources extracts CPU/memory and the full set of accelerator
// resources (any resource key that isn't cpu/memory). The legacy `gpu` int
// stays for backward compat — it's the count under nvidia.com/gpu when
// present, otherwise the first non-cpu/non-memory limit. gpuValues carries
// the full key→count map so HAMi-style requests (gpualloc/gpucores/gpumem)
// surface in the UI without losing the auxiliary fields.
func containerResources(obj map[string]any) (cpu string, memory string, gpu int64, gpuValues map[string]int64) {
	cpu, _, _ = unstructured.NestedString(obj, "resources", "requests", "cpu")
	if cpu == "" {
		cpu, _, _ = unstructured.NestedString(obj, "resources", "limits", "cpu")
	}
	memory, _, _ = unstructured.NestedString(obj, "resources", "requests", "memory")
	if memory == "" {
		memory, _, _ = unstructured.NestedString(obj, "resources", "limits", "memory")
	}

	limits, _, _ := unstructured.NestedMap(obj, "resources", "limits")
	requests, _, _ := unstructured.NestedMap(obj, "resources", "requests")
	gpuValues = mergeAcceleratorResources(limits, requests)

	if v, ok := gpuValues["nvidia.com/gpu"]; ok {
		gpu = v
	} else if len(gpuValues) > 0 {
		// First non-cpu/non-memory key — gives the UI something to show even
		// for non-NVIDIA accelerators (Ascend, AMD, …).
		for _, v := range gpuValues {
			gpu = v
			break
		}
	}
	return
}

// mergeAcceleratorResources walks limits then requests and collects every
// resource key that isn't cpu/memory, normalising values to int64.
func mergeAcceleratorResources(limits, requests map[string]any) map[string]int64 {
	out := map[string]int64{}
	collect := func(src map[string]any) {
		for k, v := range src {
			if k == "cpu" || k == "memory" || k == "" {
				continue
			}
			if _, exists := out[k]; exists {
				continue
			}
			switch t := v.(type) {
			case int64:
				out[k] = t
			case float64:
				out[k] = int64(t)
			case string:
				if n := parseInt64Quantity(t); n > 0 {
					out[k] = n
				}
			}
		}
	}
	collect(limits)
	collect(requests)
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseInt64Quantity(s string) int64 {
	var v int64
	for _, c := range s {
		if c >= '0' && c <= '9' {
			v = v*10 + int64(c-'0')
			continue
		}
		break
	}
	return v
}

// inferenceStatus collapses the conditions array into the prototype's
// Ready / Progressing / Failed / Stopped enum.
func inferenceStatus(o *unstructured.Unstructured, stopped bool) string {
	if stopped {
		return "Stopped"
	}
	conds, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
	for _, raw := range conds {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		t, _, _ := unstructured.NestedString(m, "type")
		s, _, _ := unstructured.NestedString(m, "status")
		if t == "Ready" {
			switch s {
			case "True":
				return "Ready"
			case "False":
				return "Failed"
			}
		}
	}
	return "Progressing"
}

// isStopped reports whether the resource has been quiesced — either via the
// KServe `serving.kserve.io/stop` annotation (v0.12+), or by manually scaling
// both min/maxReplicas to 0.
func isStopped(o *unstructured.Unstructured) bool {
	annos := o.GetAnnotations()
	if v, ok := annos[stopAnnotation]; ok {
		return v == "true" || v == "True"
	}
	// Fallback: spec.predictor.minReplicas == 0 && maxReplicas == 0 for v1beta1
	// or spec.minReplicas == 0 && maxReplicas == 0 for v1alpha1.
	for _, base := range [][]string{{"spec", "predictor"}, {"spec"}} {
		min, minOk, _ := unstructured.NestedInt64(o.Object, append(base, "minReplicas")...)
		max, maxOk, _ := unstructured.NestedInt64(o.Object, append(base, "maxReplicas")...)
		if minOk && maxOk && min == 0 && max == 0 {
			return true
		}
	}
	return false
}

// deploymentMode is read from the standard KServe annotation; when missing
// KServe defaults to "Serverless" (Knative-backed). v1alpha1 LLMInference
// services typically run in "RawDeployment" mode.
func deploymentMode(o *unstructured.Unstructured) string {
	if v := o.GetAnnotations()[deploymentModeAnnotation]; v != "" {
		return v
	}
	if o.GetKind() == "LLMInferenceService" {
		return "RawDeployment"
	}
	return "Serverless"
}

const (
	stopAnnotation           = "serving.kserve.io/stop"
	deploymentModeAnnotation = "serving.kserve.io/deploymentMode"
)

func containsCI(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		match := true
		for j := 0; j < len(sub); j++ {
			a := s[i+j]
			b := sub[j]
			if a >= 'A' && a <= 'Z' {
				a += 32
			}
			if b >= 'A' && b <= 'Z' {
				b += 32
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
