// Package inference owns the form-shaped Create endpoints for KServe
// InferenceService / LLMInferenceService / ServingRuntime resources.
//
// List / Get / YAML / Delete are served by the generic k8sres dispatcher;
// only the structured Create paths live here, because they need to translate
// the React form fields into the right CRD apiVersion + spec layout.
package inference

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// CreateServiceRequest is the body of POST /namespaces/{ns}/inference/services.
type CreateServiceRequest struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`     // "InferenceService" | "LLMInferenceService"
	Runtime  string `json:"runtime"`  // ServingRuntime name to use
	ModelURI string `json:"modelUri"` // hf://, s3://, oci://, modelscope://
	Replicas int64  `json:"replicas"`

	CPURequest    string `json:"cpuRequest"`
	CPULimit      string `json:"cpuLimit,omitempty"`
	MemoryRequest string `json:"memoryRequest"`
	MemoryLimit   string `json:"memoryLimit,omitempty"`

	// GPUValues encodes the resource keys/quantities chosen via the
	// platform's GPU profile picker, e.g. {"nvidia.com/gpu": 1} or
	// {"nvidia.com/gpualloc": 1, "nvidia.com/gpucores": 50, ...}. We pass
	// these through verbatim into resources.limits.
	GPUValues map[string]int64 `json:"gpuValues,omitempty"`

	Env     []EnvVar `json:"env,omitempty"`
	Command []string `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
}

// CreateRuntimeRequest is the body of POST /namespaces/{ns}/inference/runtimes.
type CreateRuntimeRequest struct {
	Name                  string   `json:"name"`
	Image                 string   `json:"image"`
	Runtime               string   `json:"runtime"` // vllm | sglang | custom — for default arg presets
	SupportedModelFormats []string `json:"supportedModelFormats,omitempty"`
	Args                  []string `json:"args,omitempty"`

	CPULimit    string `json:"cpuLimit,omitempty"`
	MemoryLimit string `json:"memoryLimit,omitempty"`
	GPULimit    int64  `json:"gpuLimit,omitempty"`
}
