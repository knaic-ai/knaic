// Package notebook owns the Create endpoint for Kubeflow Notebook CRs.
//
// Read paths (list/get/yaml/delete) are served by the generic k8sres
// dispatcher; the Create path lives here because it needs to translate the
// React form (image, resources, volume mode, shared memory) into a Notebook
// CRD plus an optional matching PersistentVolumeClaim.
package notebook

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type VolumeKind string

const (
	VolumeNew      VolumeKind = "new"
	VolumeExisting VolumeKind = "existing"
	VolumeNone     VolumeKind = "none"
)

type Volume struct {
	Kind         VolumeKind `json:"kind"`
	PVCName      string     `json:"pvcName,omitempty"`
	StorageClass string     `json:"storageClass,omitempty"`
	Capacity     string     `json:"capacity,omitempty"`
	MountPath    string     `json:"mountPath,omitempty"`
}

type CreateRequest struct {
	Name  string `json:"name"`
	Image string `json:"image"`

	CPURequest    string `json:"cpuRequest"`
	CPULimit      string `json:"cpuLimit,omitempty"`
	MemoryRequest string `json:"memoryRequest"`
	MemoryLimit   string `json:"memoryLimit,omitempty"`

	GPUValues map[string]int64 `json:"gpuValues,omitempty"`

	SharedMemory string   `json:"sharedMemory,omitempty"` // e.g. "2Gi"
	Volume       Volume   `json:"volume"`
	Env          []EnvVar `json:"env,omitempty"`

	Owner string `json:"owner,omitempty"`
}

// StopRequest / StartRequest carry no body — controller-managed by patching
// the spec.template.spec.containers[].image-and-replicas via a single
// scale-style toggle. The Kubeflow Notebook controller uses an annotation
// (`kubeflow-resource-stopped`) for this.
type StopRequest struct{}
type StartRequest struct{}
