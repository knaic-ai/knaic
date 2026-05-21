package collections

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
)

const schema = `
CREATE TABLE IF NOT EXISTS knaic_collections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    owner       TEXT NOT NULL DEFAULT '',
    scope       TEXT NOT NULL CHECK (scope IN ('public','private')),
    namespace   TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon_color  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS knaic_collections_uniq
    ON knaic_collections (scope, namespace, name);
CREATE INDEX IF NOT EXISTS knaic_collections_scope_ns
    ON knaic_collections (scope, namespace);
`

type PostgresStore struct {
	db *sqlx.DB
}

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

type row struct {
	ID          string    `db:"id"`
	Name        string    `db:"name"`
	Owner       string    `db:"owner"`
	Scope       string    `db:"scope"`
	Namespace   string    `db:"namespace"`
	Description string    `db:"description"`
	IconColor   string    `db:"icon_color"`
	CreatedAt   time.Time `db:"created_at"`
	UpdatedAt   time.Time `db:"updated_at"`
}

func (r row) toCollection() Collection {
	return Collection{
		ID:          r.ID,
		Name:        r.Name,
		Owner:       r.Owner,
		Scope:       Scope(r.Scope),
		Namespace:   r.Namespace,
		Description: r.Description,
		IconColor:   r.IconColor,
		CreatedAt:   r.CreatedAt,
		UpdatedAt:   r.UpdatedAt,
	}
}

func (s *PostgresStore) List(ctx context.Context, scope Scope, namespace string) ([]Collection, error) {
	var rows []row
	q := `SELECT * FROM knaic_collections WHERE scope = $1 AND ($2 = '' OR namespace = $2)
	      ORDER BY name ASC, id ASC`
	if err := s.db.SelectContext(ctx, &rows, q, string(scope), namespace); err != nil {
		return nil, err
	}
	out := make([]Collection, len(rows))
	for i, r := range rows {
		out[i] = r.toCollection()
	}
	return out, nil
}

func (s *PostgresStore) Get(ctx context.Context, id string) (Collection, error) {
	var r row
	if err := s.db.GetContext(ctx, &r, `SELECT * FROM knaic_collections WHERE id = $1`, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Collection{}, ErrNotFound
		}
		return Collection{}, err
	}
	return r.toCollection(), nil
}

func (s *PostgresStore) Create(ctx context.Context, c Collection) (Collection, error) {
	if c.CreatedAt.IsZero() {
		c.CreatedAt = time.Now().UTC()
	}
	if c.UpdatedAt.IsZero() {
		c.UpdatedAt = c.CreatedAt
	}
	q := `INSERT INTO knaic_collections
	      (id, name, owner, scope, namespace, description, icon_color, created_at, updated_at)
	      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`
	_, err := s.db.ExecContext(ctx, q,
		c.ID, c.Name, c.Owner, string(c.Scope), c.Namespace,
		c.Description, c.IconColor, c.CreatedAt, c.UpdatedAt)
	if err != nil {
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return Collection{}, ErrConflict
		}
		return Collection{}, err
	}
	return c, nil
}

func (s *PostgresStore) Update(ctx context.Context, id string, mutate func(*Collection) error) (Collection, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return Collection{}, err
	}
	defer tx.Rollback() //nolint:errcheck

	var r row
	if err := tx.GetContext(ctx, &r, `SELECT * FROM knaic_collections WHERE id = $1 FOR UPDATE`, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Collection{}, ErrNotFound
		}
		return Collection{}, err
	}
	c := r.toCollection()
	if err := mutate(&c); err != nil {
		return Collection{}, err
	}
	c.UpdatedAt = time.Now().UTC()
	_, err = tx.ExecContext(ctx,
		`UPDATE knaic_collections SET name=$1, description=$2, icon_color=$3, updated_at=$4 WHERE id=$5`,
		c.Name, c.Description, c.IconColor, c.UpdatedAt, c.ID,
	)
	if err != nil {
		return Collection{}, err
	}
	if err := tx.Commit(); err != nil {
		return Collection{}, err
	}
	return c, nil
}

func (s *PostgresStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM knaic_collections WHERE id = $1`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) Close() error { return s.db.Close() }
