package playground

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
)

const agentSchema = `
CREATE TABLE IF NOT EXISTS knaic_agent_sessions (
    id                 TEXT PRIMARY KEY,
    owner              TEXT NOT NULL,
    namespace          TEXT NOT NULL DEFAULT '',
    provider_id         TEXT NOT NULL,
    opencode_session_id TEXT NOT NULL,
    title              TEXT NOT NULL,
    skills             TEXT[] NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knaic_agent_sessions_owner_ns
    ON knaic_agent_sessions (owner, namespace, updated_at DESC);

CREATE TABLE IF NOT EXISTS knaic_agent_messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES knaic_agent_sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knaic_agent_messages_session_time
    ON knaic_agent_messages (session_id, created_at ASC);
`

type PostgresAgentStore struct {
	db *sqlx.DB
}

func NewPostgresAgentStore(ctx context.Context, dsn string) (*PostgresAgentStore, error) {
	db, err := sqlx.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	if _, err := db.ExecContext(ctx, agentSchema); err != nil {
		return nil, fmt.Errorf("apply agent schema: %w", err)
	}
	return &PostgresAgentStore{db: db}, nil
}

func (s *PostgresAgentStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

type agentSessionRow struct {
	ID              string         `db:"id"`
	Owner           string         `db:"owner"`
	Namespace       string         `db:"namespace"`
	ProviderID      string         `db:"provider_id"`
	OpenCodeSession string         `db:"opencode_session_id"`
	Title           string         `db:"title"`
	Skills          pq.StringArray `db:"skills"`
	CreatedAt       time.Time      `db:"created_at"`
	UpdatedAt       time.Time      `db:"updated_at"`
}

type agentMessageRow struct {
	ID        string    `db:"id"`
	SessionID string    `db:"session_id"`
	Role      string    `db:"role"`
	Content   string    `db:"content"`
	CreatedAt time.Time `db:"created_at"`
}

func (r agentSessionRow) toSession() AgentSession {
	return AgentSession{
		ID:              r.ID,
		Owner:           r.Owner,
		Namespace:       r.Namespace,
		ProviderID:      r.ProviderID,
		OpenCodeSession: r.OpenCodeSession,
		Title:           r.Title,
		Skills:          []string(r.Skills),
		CreatedAt:       r.CreatedAt,
		UpdatedAt:       r.UpdatedAt,
	}
}

func (r agentMessageRow) toMessage() AgentMessage {
	return AgentMessage{
		ID:        r.ID,
		Role:      r.Role,
		Content:   r.Content,
		CreatedAt: r.CreatedAt,
	}
}

func (s *PostgresAgentStore) ListSessions(ctx context.Context, owner, namespace string) ([]AgentSession, error) {
	var rows []agentSessionRow
	if err := s.db.SelectContext(
		ctx,
		&rows,
		`SELECT * FROM knaic_agent_sessions
		 WHERE owner = $1 AND ($2 = '' OR namespace = $2)
		 ORDER BY updated_at DESC, id ASC`,
		owner,
		namespace,
	); err != nil {
		return nil, err
	}
	out := make([]AgentSession, len(rows))
	for i, row := range rows {
		out[i] = row.toSession()
	}
	return out, nil
}

func (s *PostgresAgentStore) CreateSession(ctx context.Context, session AgentSession) (AgentSession, error) {
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
	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO knaic_agent_sessions
		   (id, owner, namespace, provider_id, opencode_session_id, title, skills, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		session.ID,
		session.Owner,
		session.Namespace,
		session.ProviderID,
		session.OpenCodeSession,
		session.Title,
		pq.StringArray(session.Skills),
		session.CreatedAt,
		session.UpdatedAt,
	); err != nil {
		return AgentSession{}, err
	}
	return session, nil
}

func (s *PostgresAgentStore) GetSession(ctx context.Context, owner, id string) (AgentSession, error) {
	var row agentSessionRow
	if err := s.db.GetContext(ctx, &row, `SELECT * FROM knaic_agent_sessions WHERE owner = $1 AND id = $2`, owner, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AgentSession{}, ErrNotFound
		}
		return AgentSession{}, err
	}
	session := row.toSession()
	var msgs []agentMessageRow
	if err := s.db.SelectContext(ctx, &msgs, `SELECT * FROM knaic_agent_messages WHERE session_id = $1 ORDER BY created_at ASC`, id); err != nil {
		return AgentSession{}, err
	}
	session.Messages = make([]AgentMessage, len(msgs))
	for i, msg := range msgs {
		session.Messages[i] = msg.toMessage()
	}
	return session, nil
}

func (s *PostgresAgentStore) DeleteSession(ctx context.Context, owner, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM knaic_agent_sessions WHERE owner = $1 AND id = $2`, owner, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresAgentStore) AppendMessage(ctx context.Context, sessionID string, msg AgentMessage) error {
	if msg.ID == "" {
		msg.ID = newID("msg")
	}
	if msg.CreatedAt.IsZero() {
		msg.CreatedAt = time.Now().UTC()
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(
		ctx,
		`UPDATE knaic_agent_sessions SET updated_at = $2 WHERE id = $1`,
		sessionID,
		msg.CreatedAt,
	)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO knaic_agent_messages (id, session_id, role, content, created_at)
		 VALUES ($1,$2,$3,$4,$5)`,
		msg.ID,
		sessionID,
		msg.Role,
		msg.Content,
		msg.CreatedAt,
	); err != nil {
		return err
	}
	return tx.Commit()
}
