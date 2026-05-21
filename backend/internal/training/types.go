// Package training owns the Create endpoints for Kubeflow Trainer v2
// TrainingRuntime and TrainJob CRDs, plus a thin MLflow tracing proxy that
// the Train Jobs page uses to render its loss / accuracy charts.
//
// Read paths (list/get/yaml/delete) for both CRDs are served by the generic
// k8sres dispatcher.
package training

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// RuntimePreJob is one pre-training step (e.g. dataset download, model
// download). Each becomes a sibling replicatedJob in the TrainingRuntime,
// linked by dependsOn so they run in order before the trainer.
type RuntimePreJob struct {
	Name    string   `json:"name"`
	Image   string   `json:"image"`
	Command []string `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	Env     []EnvVar `json:"env,omitempty"`
}

// CreateRuntimeRequest is the body of POST /namespaces/{ns}/training/runtimes.
type CreateRuntimeRequest struct {
	Name      string `json:"name"`
	Framework string `json:"framework"` // torch | deepspeed | mpi | tensorflow | jax
	Image     string `json:"image"`
	NumNodes  int64  `json:"numNodes"`

	// Trainer container overrides. Empty fields keep the image defaults.
	Command []string `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	Env     []EnvVar `json:"env,omitempty"`

	// Resources are request/limit pairs (InferenceRuntime parity). When a
	// limit is empty we copy from the request. GPUValues is keyed on the
	// extended resource name (nvidia.com/gpu, nvidia.com/gpualloc, …).
	CPURequest    string           `json:"cpuRequest,omitempty"`
	CPULimit      string           `json:"cpuLimit,omitempty"`
	MemoryRequest string           `json:"memoryRequest,omitempty"`
	MemoryLimit   string           `json:"memoryLimit,omitempty"`
	GPUValues     map[string]int64 `json:"gpuValues,omitempty"`

	// PreJobs run in order before the trainer. Each becomes its own
	// replicatedJob; the trainer dependsOn the last pre-job.
	PreJobs []RuntimePreJob `json:"preJobs,omitempty"`
}

// CreateJobRequest is the body of POST /namespaces/{ns}/training/jobs.
type CreateJobRequest struct {
	Name     string `json:"name"`
	Runtime  string `json:"runtime"`
	NumNodes int64  `json:"numNodes"`

	Command []string `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	Env     []EnvVar `json:"env,omitempty"`

	CPURequest    string `json:"cpuRequest"`
	CPULimit      string `json:"cpuLimit,omitempty"`
	MemoryRequest string `json:"memoryRequest"`
	MemoryLimit   string `json:"memoryLimit,omitempty"`

	GPUValues map[string]int64 `json:"gpuValues,omitempty"`

	ModelURI   string `json:"modelUri,omitempty"`
	DatasetURI string `json:"datasetUri,omitempty"`

	// MLflow tracking metadata is recorded as annotations on the TrainJob
	// so the dashboard can resolve the run without needing a discovery
	// service. Empty strings disable.
	MLflowTrackingURI string `json:"mlflowTrackingUri,omitempty"`
	MLflowExperiment  string `json:"mlflowExperiment,omitempty"`
}

// MLflowSample mirrors data/training.ts MLflowSample.
type MLflowSample struct {
	Step     int     `json:"step"`
	Loss     float64 `json:"loss"`
	Accuracy float64 `json:"accuracy,omitempty"`
}

// MLflowRun is the response of GET /training/jobs/{name}/mlflow.
type MLflowRun struct {
	TrackingURI string         `json:"trackingUri"`
	Experiment  string         `json:"experiment"`
	RunID       string         `json:"runId"`
	Samples     []MLflowSample `json:"samples"`
	// Source explains where the samples came from; useful for the UI to
	// surface a "live"/"cached" tag.
	Source string `json:"source"`
}
