package playground

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sort"
	"sync"
	"time"
)

type MemoryAgentStore struct {
	mu       sync.RWMutex
	sessions map[string]AgentSession
	messages map[string][]AgentMessage
	counter  int64
}

func NewMemoryAgentStore() *MemoryAgentStore {
	return &MemoryAgentStore{
		sessions: map[string]AgentSession{},
		messages: map[string][]AgentMessage{},
	}
}

func (s *MemoryAgentStore) ListSessions(_ context.Context, owner, namespace string) ([]AgentSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []AgentSession{}
	for _, session := range s.sessions {
		if session.Owner != owner {
			continue
		}
		if namespace != "" && session.Namespace != namespace {
			continue
		}
		session.Messages = nil
		out = append(out, session)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].UpdatedAt.After(out[j].UpdatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *MemoryAgentStore) CreateSession(_ context.Context, session AgentSession) (AgentSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.counter++
	now := time.Now().UTC()
	if session.ID == "" {
		session.ID = newID("agent")
	}
	if session.OpenCodeSession == "" {
		session.OpenCodeSession = session.ID
	}
	if session.CreatedAt.IsZero() {
		session.CreatedAt = now
	}
	if session.UpdatedAt.IsZero() {
		session.UpdatedAt = session.CreatedAt
	}
	s.sessions[session.ID] = session
	return session, nil
}

func (s *MemoryAgentStore) GetSession(_ context.Context, owner, id string) (AgentSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[id]
	if !ok || session.Owner != owner {
		return AgentSession{}, ErrNotFound
	}
	session.Messages = append([]AgentMessage(nil), s.messages[id]...)
	return session, nil
}

func (s *MemoryAgentStore) DeleteSession(_ context.Context, owner, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	if !ok || session.Owner != owner {
		return ErrNotFound
	}
	delete(s.sessions, id)
	delete(s.messages, id)
	return nil
}

func (s *MemoryAgentStore) AppendMessage(_ context.Context, sessionID string, msg AgentMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[sessionID]
	if !ok {
		return ErrNotFound
	}
	if msg.ID == "" {
		msg.ID = newID("msg")
	}
	if msg.CreatedAt.IsZero() {
		msg.CreatedAt = time.Now().UTC()
	}
	s.messages[sessionID] = append(s.messages[sessionID], msg)
	session.UpdatedAt = msg.CreatedAt
	s.sessions[sessionID] = session
	return nil
}

func newID(prefix string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + hex.EncodeToString(b[:])
}
