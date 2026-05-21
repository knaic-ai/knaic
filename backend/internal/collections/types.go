// Package collections groups related models into series (e.g. all
// Qwen3.5 variants share one collection). It mirrors the structure of
// internal/models: a small Service + a Store interface with in-memory
// and Postgres implementations.
package collections

import "time"

type Scope string

const (
	ScopePublic  Scope = "public"
	ScopePrivate Scope = "private"
)

type Collection struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Owner       string    `json:"owner"`
	Scope       Scope     `json:"scope"`
	Namespace   string    `json:"namespace,omitempty"`
	Description string    `json:"description"`
	IconColor   string    `json:"iconColor,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type CreateRequest struct {
	ID          string `json:"id,omitempty"` // optional; server fills when empty
	Name        string `json:"name"`
	Scope       Scope  `json:"scope"`
	Namespace   string `json:"namespace,omitempty"`
	Description string `json:"description,omitempty"`
	IconColor   string `json:"iconColor,omitempty"`
}

type PatchRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	IconColor   *string `json:"iconColor,omitempty"`
}
