package playground

import "io"

type ProviderSource string

const (
	SourceCluster  ProviderSource = "cluster"
	SourceExternal ProviderSource = "external"
)

type ProviderStatus string

const (
	StatusReady       ProviderStatus = "Ready"
	StatusProgressing ProviderStatus = "Progressing"
	StatusFailed      ProviderStatus = "Failed"
)

type Provider struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Source      ProviderSource `json:"source"`
	Namespace   string         `json:"namespace,omitempty"`
	Endpoint    string         `json:"endpoint"`
	APIKey      string         `json:"apiKey,omitempty"`
	Model       string         `json:"model"`
	Description string         `json:"description,omitempty"`
	Status      ProviderStatus `json:"status"`
}

type ProviderRequest struct {
	Name        string         `json:"name"`
	Source      ProviderSource `json:"source"`
	Namespace   string         `json:"namespace,omitempty"`
	Endpoint    string         `json:"endpoint"`
	APIKey      string         `json:"apiKey,omitempty"`
	Model       string         `json:"model"`
	Description string         `json:"description,omitempty"`
	Status      ProviderStatus `json:"status,omitempty"`
}

type ProviderPatch struct {
	Name        *string         `json:"name,omitempty"`
	Source      *ProviderSource `json:"source,omitempty"`
	Namespace   *string         `json:"namespace,omitempty"`
	Endpoint    *string         `json:"endpoint,omitempty"`
	APIKey      *string         `json:"apiKey,omitempty"`
	Model       *string         `json:"model,omitempty"`
	Description *string         `json:"description,omitempty"`
	Status      *ProviderStatus `json:"status,omitempty"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	ProviderID  string    `json:"providerId"`
	Messages    []Message `json:"messages"`
	Temperature *float64  `json:"temperature,omitempty"`
	MaxTokens   *int      `json:"maxTokens,omitempty"`
}

type ChatResponse struct {
	Message Message `json:"message"`
	Raw     any     `json:"raw,omitempty"`
}

type ChatStream struct {
	Body        io.ReadCloser
	ContentType string
}
