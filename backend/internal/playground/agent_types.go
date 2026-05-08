package playground

import (
	"context"
	"time"

	"github.com/alauda/knaic-backend/internal/auth"
)

type AgentMessage struct {
	ID        string    `json:"id"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
}

type AgentSession struct {
	ID              string         `json:"id"`
	Owner           string         `json:"owner"`
	Namespace       string         `json:"namespace,omitempty"`
	ProviderID      string         `json:"providerId"`
	OpenCodeSession string         `json:"opencodeSessionId,omitempty"`
	Title           string         `json:"title"`
	Skills          []string       `json:"skills"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	Messages        []AgentMessage `json:"messages,omitempty"`
}

type CreateAgentSessionRequest struct {
	Namespace  string   `json:"namespace,omitempty"`
	ProviderID string   `json:"providerId"`
	Title      string   `json:"title,omitempty"`
	Skills     []string `json:"skills,omitempty"`
}

type AgentRunRequest struct {
	Message string `json:"message"`
}

type AgentRunContext struct {
	APIBaseURL string
	UserToken  string
	Namespace  string
}

type AgentEvent struct {
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	MessageID string `json:"messageId,omitempty"`
	ToolName  string `json:"toolName,omitempty"`
}

type AgentRunnerRequest struct {
	SessionID  string
	Message    string
	Provider   Provider
	UserToken  string
	Namespace  string
	Skills     []string
	APIBaseURL string
}

type AgentRunner interface {
	Run(ctx context.Context, req AgentRunnerRequest, emit func(AgentEvent)) error
}

type AgentStore interface {
	ListSessions(ctx context.Context, owner, namespace string) ([]AgentSession, error)
	CreateSession(ctx context.Context, s AgentSession) (AgentSession, error)
	GetSession(ctx context.Context, owner, id string) (AgentSession, error)
	DeleteSession(ctx context.Context, owner, id string) error
	AppendMessage(ctx context.Context, sessionID string, msg AgentMessage) error
}

func ownerFromUser(u *auth.User) string {
	if u == nil {
		return ""
	}
	switch {
	case u.Subject != "":
		return u.Subject
	case u.Email != "":
		return u.Email
	default:
		return u.Name
	}
}
