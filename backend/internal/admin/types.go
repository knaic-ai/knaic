package admin

import "time"

type Taint struct {
	Key    string `json:"key"`
	Value  string `json:"value,omitempty"`
	Effect string `json:"effect"`
}

type NodeInfo struct {
	Name    string            `json:"name"`
	Role    string            `json:"role"`
	CPU     string            `json:"cpu"`
	Memory  string            `json:"memory"`
	GPU     string            `json:"gpu"`
	Status  string            `json:"status"`
	Kubelet string            `json:"kubelet"`
	Kernel  string            `json:"kernel"`
	Labels  map[string]string `json:"labels"`
	Taints  []Taint           `json:"taints"`
}

type NodePatch struct {
	Labels map[string]string `json:"labels,omitempty"`
	Taints []Taint           `json:"taints,omitempty"`
}

type Quota struct {
	CPU      int64 `json:"cpu"`
	MemoryGi int64 `json:"memory"`
	GPU      int64 `json:"gpu"`
	Pods     int64 `json:"pods"`
}

type Namespace struct {
	Name   string            `json:"name"`
	Status string            `json:"status"`
	Labels map[string]string `json:"labels,omitempty"`
	Quota  Quota             `json:"quota"`
}

type NamespaceRequest struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels,omitempty"`
	Quota  Quota             `json:"quota"`
}

type PolicyRule struct {
	APIGroups []string `json:"apiGroups"`
	Resources []string `json:"resources"`
	Verbs     []string `json:"verbs"`
}

type Role struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Namespace string       `json:"namespace,omitempty"`
	Kind      string       `json:"kind"`
	Rules     []PolicyRule `json:"rules"`
}

type RoleRef struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type Subject struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type RoleBinding struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Namespace string    `json:"namespace"`
	RoleRef   RoleRef   `json:"roleRef"`
	Subjects  []Subject `json:"subjects"`
}

type NamespaceRole string

const (
	NamespaceAdmin  NamespaceRole = "admin"
	NamespaceEditor NamespaceRole = "editor"
	NamespaceViewer NamespaceRole = "viewer"
)

type UserRecord struct {
	ID              string                   `json:"id"`
	Name            string                   `json:"name"`
	Email           string                   `json:"email"`
	OIDCSub         string                   `json:"oidcSub"`
	FirstSeen       time.Time                `json:"firstSeen"`
	LastSeen        time.Time                `json:"lastSeen"`
	IsPlatformAdmin bool                     `json:"isPlatformAdmin"`
	Memberships     map[string]NamespaceRole `json:"memberships"`
}

type UserPatch struct {
	IsPlatformAdmin *bool                    `json:"isPlatformAdmin,omitempty"`
	Memberships     map[string]NamespaceRole `json:"memberships,omitempty"`
}
