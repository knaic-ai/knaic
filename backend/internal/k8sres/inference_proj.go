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
	if c != nil {
		image, _, _ = unstructured.NestedString(c, "image")
		args, _, _ := unstructured.NestedStringSlice(c, "args")
		defaultArgs = args
		cpu, _, _ := unstructured.NestedString(c, "resources", "limits", "cpu")
		mem, _, _ := unstructured.NestedString(c, "resources", "limits", "memory")
		gpu, _, _ := unstructured.NestedString(c, "resources", "limits", "nvidia.com/gpu")
		resources["cpu"] = cpu
		resources["memory"] = mem
		if gpu != "" {
			resources["gpu"] = gpu
		}
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
	p["builtin"] = false
	return p
}

// projectInferenceService matches the v1beta1 KServe shape.
func projectInferenceService(o *unstructured.Unstructured) Projection {
	p := base(o)
	min, _, _ := unstructured.NestedInt64(o.Object, "spec", "predictor", "minReplicas")
	if min == 0 {
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
	cpu, mem, gpu := containerResources(model)
	if cpu == "" {
		if pod, ok, _ := unstructured.NestedMap(o.Object, "spec", "predictor"); ok {
			if c, found := nestedFirstContainer(pod, "containers"); found {
				cpu, mem, gpu = containerResources(c)
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
	p["endpoint"] = endpoint
	p["status"] = inferenceStatus(o)
	return p
}

func projectLLMInferenceService(o *unstructured.Unstructured) Projection {
	p := base(o)
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
	if min == 0 {
		min = 1
	}
	max, _, _ := unstructured.NestedInt64(o.Object, "spec", "maxReplicas")
	if max == 0 {
		max = min
	}
	cpu, mem, gpu := "", "", int64(0)
	if model, ok, _ := unstructured.NestedMap(o.Object, "spec", "model"); ok {
		cpu, mem, gpu = containerResources(model)
	}
	endpoint, _, _ := unstructured.NestedString(o.Object, "status", "url")
	p["kind"] = "LLMInferenceService"
	p["runtime"] = runtime
	p["modelUri"] = storageURI
	p["minReplicas"] = min
	p["maxReplicas"] = max
	p["resources"] = map[string]any{"cpu": cpu, "memory": mem, "gpu": gpu}
	p["endpoint"] = endpoint
	p["status"] = inferenceStatus(o)
	return p
}

func containerResources(obj map[string]any) (cpu string, memory string, gpu int64) {
	cpu, _, _ = unstructured.NestedString(obj, "resources", "requests", "cpu")
	memory, _, _ = unstructured.NestedString(obj, "resources", "requests", "memory")
	if v, ok, _ := unstructured.NestedInt64(obj, "resources", "limits", "nvidia.com/gpu"); ok {
		gpu = v
	} else if s, ok, _ := unstructured.NestedString(obj, "resources", "limits", "nvidia.com/gpu"); ok && s != "" {
		// Quantity may be encoded as a string in some chart versions.
		gpu = parseInt64Quantity(s)
	}
	return
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
// Ready / Progressing / Failed enum.
func inferenceStatus(o *unstructured.Unstructured) string {
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
