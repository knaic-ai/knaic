package playground

import (
	"context"
	"testing"

	"github.com/knaic/knaic-backend/internal/auth"
)

func TestMemoryAgentStoreScopesSessionsByOwner(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryAgentStore()

	alice, err := store.CreateSession(ctx, AgentSession{
		Owner:      "alice",
		Namespace:  "team-ml",
		ProviderID: "llm-1",
		Title:      "Alice session",
		Skills:     []string{"cluster-health"},
	})
	if err != nil {
		t.Fatalf("create alice session: %v", err)
	}
	if _, err := store.CreateSession(ctx, AgentSession{
		Owner:      "bob",
		Namespace:  "team-ml",
		ProviderID: "llm-1",
		Title:      "Bob session",
	}); err != nil {
		t.Fatalf("create bob session: %v", err)
	}
	if err := store.AppendMessage(ctx, alice.ID, AgentMessage{Role: "user", Content: "check pods"}); err != nil {
		t.Fatalf("append user message: %v", err)
	}

	listed, err := store.ListSessions(ctx, "alice", "team-ml")
	if err != nil {
		t.Fatalf("list alice sessions: %v", err)
	}
	if len(listed) != 1 || listed[0].Owner != "alice" || listed[0].ID != alice.ID {
		t.Fatalf("listed sessions = %#v, want only alice session", listed)
	}

	got, err := store.GetSession(ctx, "alice", alice.ID)
	if err != nil {
		t.Fatalf("get alice session: %v", err)
	}
	if len(got.Messages) != 1 || got.Messages[0].Content != "check pods" {
		t.Fatalf("messages = %#v, want appended user message", got.Messages)
	}
}

func TestAgentRunStoresUserAndFinalAssistantMessages(t *testing.T) {
	ctx := context.Background()
	runner := &fakeAgentRunner{events: []AgentEvent{
		{Kind: "thought", Text: "checking"},
		{Kind: "final", Text: "cluster looks "},
		{Kind: "final", Text: "healthy"},
	}}
	svc := NewServiceWithAgentStore(NewMemoryAgentStore(), runner)
	provider, err := svc.CreateProvider(ctx, ProviderRequest{
		Name:     "cluster-qwen",
		Source:   SourceCluster,
		Endpoint: "http://qwen.team-ml.svc/v1",
		Model:    "qwen",
		Status:   StatusReady,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	user := &auth.User{Subject: "alice", Email: "alice@example.com", Name: "alice"}
	session, err := svc.CreateAgentSession(ctx, user, CreateAgentSessionRequest{
		Namespace:  "team-ml",
		ProviderID: provider.ID,
		Title:      "Health",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	var events []AgentEvent
	if err := svc.RunAgent(ctx, user, session.ID, AgentRunRequest{
		Message: "is everything running?",
	}, AgentRunContext{
		APIBaseURL: "http://127.0.0.1:8080",
	}, func(ev AgentEvent) {
		events = append(events, ev)
	}); err != nil {
		t.Fatalf("run agent: %v", err)
	}

	got, err := svc.GetAgentSession(ctx, user, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if len(events) != 3 || events[2].Kind != "final" {
		t.Fatalf("events = %#v, want final event", events)
	}
	if len(got.Messages) != 2 {
		t.Fatalf("len(messages) = %d, want 2: %#v", len(got.Messages), got.Messages)
	}
	if got.Messages[0].Role != "user" || got.Messages[0].Content != "is everything running?" {
		t.Fatalf("user message = %#v", got.Messages[0])
	}
	if got.Messages[1].Role != "assistant" || got.Messages[1].Content != "cluster looks healthy" {
		t.Fatalf("assistant message = %#v", got.Messages[1])
	}
}

type fakeAgentRunner struct {
	events []AgentEvent
}

func (r *fakeAgentRunner) Run(ctx context.Context, req AgentRunnerRequest, emit func(AgentEvent)) error {
	for _, ev := range r.events {
		emit(ev)
	}
	return nil
}
