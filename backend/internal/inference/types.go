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

type Capabilities struct {
	Add  []string `json:"add,omitempty"`
	Drop []string `json:"drop,omitempty"`
}

type SeccompProfile struct {
	Type string `json:"type,omitempty"`
}

type SecurityContext struct {
	AllowPrivilegeEscalation *bool           `json:"allowPrivilegeEscalation,omitempty"`
	Capabilities             *Capabilities   `json:"capabilities,omitempty"`
	Privileged               *bool           `json:"privileged,omitempty"`
	RunAsNonRoot             *bool           `json:"runAsNonRoot,omitempty"`
	RunAsUser                *int64          `json:"runAsUser,omitempty"`
	SeccompProfile           *SeccompProfile `json:"seccompProfile,omitempty"`
}

// CreateServiceRequest is the body of POST /namespaces/{ns}/inference/services.
//
// Kind switches between two CRD shapes that don't actually share much:
//
//   - InferenceService   (v1beta1): predictor.model.runtime references a
//     ServingRuntime that owns the container image / args / etc.
//   - LLMInferenceService (v1alpha1): standalone resource — uses optional
//     baseRefs to merge in defaults from one or more
//     LLMInferenceServiceConfig CRs, and configures the container directly
//     under spec.template.containers[]. There is no ServingRuntime ref.
//
// Runtime is only meaningful for kind=InferenceService.
// BaseConfigs / ModelName / ContainerImage are only meaningful for
// kind=LLMInferenceService. The unrelated field for the active kind is
// silently ignored — keeping a single payload shape simplifies the form.
type CreateServiceRequest struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`     // "InferenceService" | "LLMInferenceService"
	Runtime  string `json:"runtime,omitempty"`
	ModelURI string `json:"modelUri"` // hf://, s3://, oci://, modelscope://
	Replicas int64  `json:"replicas"`

	// LLMInferenceService-only fields.
	BaseConfigs    []string `json:"baseConfigs,omitempty"`
	ModelName      string   `json:"modelName,omitempty"`
	ContainerImage string   `json:"containerImage,omitempty"`

	// DeploymentMode stamps the `serving.kserve.io/deploymentMode`
	// annotation. KServe accepts: Standard | RawDeployment | Serverless |
	// ModelMesh (subject to cluster install). Empty means "let KServe pick
	// its configured default".
	DeploymentMode string `json:"deploymentMode,omitempty"`

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

// LLMConfigRef is the projection used by the "Base config" picker in the
// LLMInferenceService form — these come from cluster-wide
// LLMInferenceServiceConfig CRs (typically in the `kserve` namespace).
type LLMConfigRef struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// DeploymentModesInfo describes which `serving.kserve.io/deploymentMode`
// values the cluster's KServe install can handle, plus the cluster's
// configured default. The form pre-fills the picker from this so users see
// only modes that will actually work.
type DeploymentModesInfo struct {
	Modes   []string `json:"modes"`
	Default string   `json:"default"`
}

// CreateRuntimeRequest is the body of POST /namespaces/{ns}/inference/runtimes.
//
// Resource fields mirror CreateServiceRequest so the form on the
// ServingRuntime page can re-use the same CPU/Memory request+limit + GPU
// profile picker as the InferenceService form.
type CreateRuntimeRequest struct {
	Name                  string          `json:"name"`
	Image                 string          `json:"image"`
	Runtime               string          `json:"runtime"` // vllm | sglang | custom — for default arg presets
	SupportedModelFormats []string        `json:"supportedModelFormats,omitempty"`
	Args                  []string        `json:"args,omitempty"`
	SecurityContext       SecurityContext `json:"securityContext,omitempty"`

	CPURequest    string `json:"cpuRequest,omitempty"`
	CPULimit      string `json:"cpuLimit,omitempty"`
	MemoryRequest string `json:"memoryRequest,omitempty"`
	MemoryLimit   string `json:"memoryLimit,omitempty"`

	// GPUValues encodes the resource keys/quantities chosen via the GPU
	// profile picker — same shape as CreateServiceRequest.GPUValues.
	// When empty, GPULimit (legacy field) is used as `nvidia.com/gpu`.
	GPUValues map[string]int64 `json:"gpuValues,omitempty"`
	GPULimit  int64            `json:"gpuLimit,omitempty"`
}
