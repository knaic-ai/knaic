package monitoring

import "time"

type Scope string

const (
	ScopeCluster   Scope = "cluster"
	ScopeNode      Scope = "node"
	ScopeNamespace Scope = "namespace"
	ScopePod       Scope = "pod"
)

type Resource string

const (
	ResourceCPU     Resource = "cpu"
	ResourceMemory  Resource = "memory"
	ResourceGPU     Resource = "gpu"
	ResourceDisk    Resource = "disk"
	ResourceNetwork Resource = "network"
)

type Kind string

const (
	KindUsage    Kind = "usage"
	KindRequests Kind = "requests"
	KindLimits   Kind = "limits"
)

type Source string

const (
	SourcePrometheus Source = "prometheus"
	SourceSynthetic  Source = "synthetic"
)

type QueryRequest struct {
	Scope    Scope
	Target   string
	Resource Resource
	Kind     Kind
	Start    time.Time
	End      time.Time
	Step     time.Duration
}

type Point struct {
	Time  string  `json:"t"`
	Value float64 `json:"v"`
}

type Series struct {
	Points []Point `json:"points"`
	Unit   string  `json:"unit"`
	Total  float64 `json:"total"`
	Source Source  `json:"source"`
	Query  string  `json:"query,omitempty"`
}
