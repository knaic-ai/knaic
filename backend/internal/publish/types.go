// Package publish implements requests to copy a private model into the
// public catalog. A request starts in state "pending"; an admin then
// approves it (which creates a new public model populated from the
// private source) or rejects it. Only private models whose URI is
// publicly accessible (hf:// hf-mirror:// modelscope:// https://) are
// eligible — IsPublicURI in this package mirrors the rule in
// internal/models.IsPublicSource.
package publish

import (
	"strings"
	"time"
)

type Status string

const (
	StatusPending  Status = "pending"
	StatusApproved Status = "approved"
	StatusRejected Status = "rejected"
)

type Request struct {
	ID              string    `json:"id"`
	PrivateModelID  string    `json:"privateModelId"`
	PrivateNamespace string   `json:"privateNamespace"`
	PrivateName     string    `json:"privateName"`
	PrivateURI      string    `json:"privateUri"`

	TargetName        string `json:"targetName"`
	TargetCollectionID string `json:"targetCollectionId,omitempty"`
	RequestedBy       string `json:"requestedBy"`
	Note              string `json:"note,omitempty"`

	Status        Status `json:"status"`
	ReviewedBy    string `json:"reviewedBy,omitempty"`
	ReviewerNote  string `json:"reviewerNote,omitempty"`
	CatalogModelID string `json:"catalogModelId,omitempty"`

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type CreateRequest struct {
	PrivateModelID    string `json:"privateModelId"`
	TargetName        string `json:"targetName"`
	TargetCollectionID string `json:"targetCollectionId,omitempty"`
	Note              string `json:"note,omitempty"`
}

type ReviewRequest struct {
	ReviewerNote string `json:"reviewerNote,omitempty"`
}

// IsPublicURI reports whether a model URI is reachable without per-namespace
// credentials. Mirrors models.IsPublicSource but lives here to keep the
// publish package independent of internal/models.
func IsPublicURI(uri string) bool {
	return strings.HasPrefix(uri, "hf://") ||
		strings.HasPrefix(uri, "hf-mirror://") ||
		strings.HasPrefix(uri, "modelscope://") ||
		strings.HasPrefix(uri, "http://") ||
		strings.HasPrefix(uri, "https://")
}
