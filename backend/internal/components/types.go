package components

import "time"

type Status string

const (
	StatusNotInstalled Status = "NotInstalled"
	StatusInstalling   Status = "Installing"
	StatusInstalled    Status = "Installed"
	StatusFailed       Status = "Failed"
	StatusUnmanaged    Status = "Unmanaged"
)

type SyncState string

const (
	SyncSynced  SyncState = "Synced"
	SyncPending SyncState = "Pending"
	SyncFailed  SyncState = "Failed"
)

type ManagedBy string

const (
	ManagedByKnaic  ManagedBy = "knaic"
	ManagedByACP    ManagedBy = "ACP"
	ManagedByOLM    ManagedBy = "OLM"
	ManagedByManual ManagedBy = "manual"
)

type Category string

const (
	CategoryInference     Category = "Inference"
	CategoryTraining      Category = "Training"
	CategoryGPU           Category = "GPU"
	CategoryNetworking    Category = "Networking"
	CategoryObservability Category = "Observability"
	CategoryNotebook      Category = "Notebook"
	CategoryScheduling    Category = "Scheduling"
	CategoryExperiment    Category = "Experiment"
)

type Component struct {
	Name            string    `json:"name"`
	DisplayName     string    `json:"displayName"`
	Description     string    `json:"description"`
	Category        Category  `json:"category"`
	Versions        []string  `json:"versions"`
	SelectedVersion string    `json:"selectedVersion"`
	Status          Status    `json:"status"`
	Namespace       string    `json:"namespace"`
	Images          []string  `json:"images"`
	ImageSync       SyncState `json:"imageSync"`
	Notes           string    `json:"notes,omitempty"`
	ManagedBy       ManagedBy `json:"managedBy,omitempty"`
	Builtin         bool      `json:"builtin"`

	// Chart is the URL of the Helm chart to install. Supports oci://, https://
	// (direct .tgz), or a Helm-repo + chart pair separated by "@" (e.g.
	// "https://charts.example.com@kserve"). When empty, the install action
	// falls back to the embedded chart bundled with knaic (if any).
	Chart string `json:"chart,omitempty"`

	// Embedded indicates whether the chart for this component is bundled
	// inside the knaic binary. Imported charts are not.
	Embedded bool `json:"embedded"`

	// Last install/uninstall outcome — useful for the UI to show errors.
	LastError      string    `json:"lastError,omitempty"`
	LastTransition time.Time `json:"lastTransition,omitempty"`
}

// ImportRequest is the body of POST /api/v1/components.
type ImportRequest struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"displayName"`
	Description string   `json:"description"`
	Category    Category `json:"category"`
	Version     string   `json:"version"`
	Namespace   string   `json:"namespace"`
	Images      []string `json:"images"`

	// ChartArchive is an optional base64-encoded .tgz to vendor in.
	// When empty, the imported chart is metadata-only and Install will fail
	// until a chart archive is supplied.
	ChartArchive string `json:"chartArchive,omitempty"`
}

// PatchRequest is the body of PATCH /api/v1/components/{name}.
type PatchRequest struct {
	SelectedVersion *string `json:"selectedVersion,omitempty"`
}
