// Package gpu computes accelerator inventory + pod usage for the Monitoring
// → GPU Status page. It supports any device plugin that surfaces its
// allocatable counts as Kubernetes resource keys — the discovery is purely
// heuristic on the resource-key prefix, so adding a new vendor (e.g. AMD's
// `amd.com/gpu`, Huawei's `huawei.com/Ascend910`, HAMi's `nvidia.com/gpualloc`)
// requires no code changes — it just shows up automatically.
package gpu

// Counts is the per-resource-key tally surfaced to the UI.
type Counts struct {
	Total     int64 `json:"total"`
	Used      int64 `json:"used"`
	Available int64 `json:"available"`
}

// VendorSummary groups one or more accelerator resource keys under a
// human-readable vendor label, so the UI can render a "NVIDIA: 8/10 used"
// row even when both `nvidia.com/gpu` and `nvidia.com/gpualloc` are present.
type VendorSummary struct {
	Vendor   string            `json:"vendor"`
	Keys     []string          `json:"keys"`
	Counts   Counts            `json:"counts"`
	ByKey    map[string]Counts `json:"byKey"`
	Primary  string            `json:"primary"` // the resource key the UI uses for the headline number
}

// NodeSummary is the per-node breakdown shown in the cluster overview.
type NodeSummary struct {
	Node       string            `json:"node"`
	Capacity   map[string]int64  `json:"capacity"`
	Allocated  map[string]int64  `json:"allocated"`
	Pods       int               `json:"pods"` // GPU-using pods scheduled on this node
}

// PodUsage is one row of the GPU-using pod table.
type PodUsage struct {
	Namespace  string             `json:"namespace"`
	Name       string             `json:"name"`
	Node       string             `json:"node,omitempty"`
	Phase      string             `json:"phase"`
	Resources  map[string]int64   `json:"resources"`  // per-pod sum
	Containers []ContainerUsage   `json:"containers"`
}

type ContainerUsage struct {
	Name      string           `json:"name"`
	Resources map[string]int64 `json:"resources"`
}

// Status is the combined response. `Nodes` is empty for non-admin callers
// who can't read nodes cluster-wide; the UI gracefully degrades.
type Status struct {
	Scope    string           `json:"scope"`
	Target   string           `json:"target,omitempty"`
	Summary  Counts           `json:"summary"`
	Vendors  []VendorSummary  `json:"vendors"`
	Nodes    []NodeSummary    `json:"nodes"`
	Pods     []PodUsage       `json:"pods"`
}
