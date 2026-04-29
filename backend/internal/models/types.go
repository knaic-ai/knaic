// Package models implements the knaic Model Hub.
//
// Models are described by metadata only — actual model files live in S3,
// OCI, HuggingFace, or ModelScope and are referenced by URI. The Store
// interface lets us swap an in-memory implementation (default; useful for
// development) with a Postgres-backed one when KNAIC_DB_URL is set.
package models

import "time"

type Scope string

const (
	ScopePublic  Scope = "public"  // visible to everyone; admin-only writes
	ScopePrivate Scope = "private" // namespace-scoped
)

type Scheme string

const (
	SchemeHF         Scheme = "hf"
	SchemeModelScope Scheme = "modelscope"
	SchemeS3         Scheme = "s3"
	SchemeOCI        Scheme = "oci"
)

type Model struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Owner     string    `json:"owner"`
	Scope     Scope     `json:"scope"`
	Namespace string    `json:"namespace,omitempty"` // required when scope=private
	URI       string    `json:"uri"`
	Scheme    Scheme    `json:"scheme"`
	Tags      []string  `json:"tags"`
	ModelType string    `json:"modelType"`
	SizeGB    float64   `json:"sizeGB"`
	Downloads int       `json:"downloads"`
	UpdatedAt time.Time `json:"updatedAt"`
	Readme    string    `json:"readme"`
}

// CreateRequest registers a model from a raw storage URI (hf/ms/s3/oci).
type CreateRequest struct {
	Name      string   `json:"name"`
	Owner     string   `json:"owner,omitempty"` // server fills from caller if empty
	Scope     Scope    `json:"scope"`
	Namespace string   `json:"namespace,omitempty"`
	URI       string   `json:"uri"`
	Tags      []string `json:"tags,omitempty"`
	ModelType string   `json:"modelType,omitempty"`
	SizeGB    float64  `json:"sizeGB,omitempty"`
	Readme    string   `json:"readme,omitempty"`
}

// ImportRequest registers a model from a HuggingFace or ModelScope URL.
// The server normalises the URL into the right scheme.
type ImportRequest struct {
	URL       string `json:"url"`
	Scope     Scope  `json:"scope"`
	Namespace string `json:"namespace,omitempty"`
}

// UploadRequest registers a model that lives in a knaic-managed storage
// target. The actual file movement is performed out-of-band by the upload
// worker; this endpoint only records metadata + the destination URI.
type UploadRequest struct {
	Name      string   `json:"name"`
	Scope     Scope    `json:"scope"`
	Namespace string   `json:"namespace,omitempty"`
	TargetURI string   `json:"targetUri"`
	ModelType string   `json:"modelType,omitempty"`
	SizeGB    float64  `json:"sizeGB,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	Readme    string   `json:"readme,omitempty"`
}

// PatchRequest covers the small mutations users make from the UI: bumping
// the download counter and editing the readme/tags.
type PatchRequest struct {
	Readme       *string  `json:"readme,omitempty"`
	Tags         []string `json:"tags,omitempty"`
	IncDownloads *int     `json:"incDownloads,omitempty"`
}
