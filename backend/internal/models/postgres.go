package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
)

// schema is applied at startup. It's idempotent — adding a column is a
// follow-up migration; for now we own a single CREATE TABLE.
const schema = `
CREATE TABLE IF NOT EXISTS knaic_models (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    owner       TEXT NOT NULL,
    scope       TEXT NOT NULL CHECK (scope IN ('public','private')),
    namespace   TEXT NOT NULL DEFAULT '',
    uri         TEXT NOT NULL,
    scheme      TEXT NOT NULL,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    model_type  TEXT NOT NULL DEFAULT '',
    size_gb     DOUBLE PRECISION NOT NULL DEFAULT 0,
    downloads   INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    readme      TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS knaic_models_uniq
    ON knaic_models (scope, namespace, name);

CREATE INDEX IF NOT EXISTS knaic_models_scope_ns
    ON knaic_models (scope, namespace);
`

type PostgresStore struct {
	db *sqlx.DB
}

// NewPostgresStore opens a connection pool, pings, and applies the schema.
func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	db, err := sqlx.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &PostgresStore{db: db}, nil
}

type modelRow struct {
	ID        string         `db:"id"`
	Name      string         `db:"name"`
	Owner     string         `db:"owner"`
	Scope     string         `db:"scope"`
	Namespace string         `db:"namespace"`
	URI       string         `db:"uri"`
	Scheme    string         `db:"scheme"`
	Tags      pq.StringArray `db:"tags"`
	ModelType string         `db:"model_type"`
	SizeGB    float64        `db:"size_gb"`
	Downloads int            `db:"downloads"`
	UpdatedAt time.Time      `db:"updated_at"`
	Readme    string         `db:"readme"`
}

func (r modelRow) toModel() Model {
	return Model{
		ID:        r.ID,
		Name:      r.Name,
		Owner:     r.Owner,
		Scope:     Scope(r.Scope),
		Namespace: r.Namespace,
		URI:       r.URI,
		Scheme:    Scheme(r.Scheme),
		Tags:      []string(r.Tags),
		ModelType: r.ModelType,
		SizeGB:    r.SizeGB,
		Downloads: r.Downloads,
		UpdatedAt: r.UpdatedAt,
		Readme:    r.Readme,
	}
}

func (s *PostgresStore) List(ctx context.Context, scope Scope, namespace string) ([]Model, error) {
	var rows []modelRow
	q := `SELECT * FROM knaic_models WHERE scope = $1 AND ($2 = '' OR namespace = $2)
	      ORDER BY updated_at DESC`
	if err := s.db.SelectContext(ctx, &rows, q, string(scope), namespace); err != nil {
		return nil, err
	}
	out := make([]Model, len(rows))
	for i, r := range rows {
		out[i] = r.toModel()
	}
	return out, nil
}

func (s *PostgresStore) Get(ctx context.Context, id string) (Model, error) {
	var r modelRow
	if err := s.db.GetContext(ctx, &r, `SELECT * FROM knaic_models WHERE id = $1`, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Model{}, ErrNotFound
		}
		return Model{}, err
	}
	return r.toModel(), nil
}

func (s *PostgresStore) Create(ctx context.Context, m Model) (Model, error) {
	if m.UpdatedAt.IsZero() {
		m.UpdatedAt = time.Now().UTC()
	}
	q := `INSERT INTO knaic_models
	      (id, name, owner, scope, namespace, uri, scheme, tags, model_type, size_gb, downloads, updated_at, readme)
	      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`
	_, err := s.db.ExecContext(ctx, q,
		m.ID, m.Name, m.Owner, string(m.Scope), m.Namespace,
		m.URI, string(m.Scheme), pq.StringArray(m.Tags), m.ModelType,
		m.SizeGB, m.Downloads, m.UpdatedAt, m.Readme,
	)
	if err != nil {
		// Translate the unique-violation error (SQLSTATE 23505) into our
		// store-level conflict so HTTP handlers can map it to 409.
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return Model{}, ErrConflict
		}
		return Model{}, err
	}
	return m, nil
}

func (s *PostgresStore) Update(ctx context.Context, id string, mutate func(*Model) error) (Model, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return Model{}, err
	}
	defer tx.Rollback() //nolint:errcheck

	var r modelRow
	if err := tx.GetContext(ctx, &r, `SELECT * FROM knaic_models WHERE id = $1 FOR UPDATE`, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Model{}, ErrNotFound
		}
		return Model{}, err
	}
	m := r.toModel()
	if err := mutate(&m); err != nil {
		return Model{}, err
	}
	m.UpdatedAt = time.Now().UTC()

	_, err = tx.ExecContext(ctx,
		`UPDATE knaic_models SET readme=$1, tags=$2, downloads=$3, updated_at=$4 WHERE id=$5`,
		m.Readme, pq.StringArray(m.Tags), m.Downloads, m.UpdatedAt, m.ID,
	)
	if err != nil {
		return Model{}, err
	}
	if err := tx.Commit(); err != nil {
		return Model{}, err
	}
	return m, nil
}

func (s *PostgresStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM knaic_models WHERE id = $1`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) Count(ctx context.Context, scope Scope) (int, error) {
	var n int
	err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM knaic_models WHERE scope = $1`, string(scope))
	return n, err
}

// Close is provided so callers (main) can release the pool on shutdown.
func (s *PostgresStore) Close() error { return s.db.Close() }
