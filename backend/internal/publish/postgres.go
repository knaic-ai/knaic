package publish

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
CREATE TABLE IF NOT EXISTS knaic_publish_requests (
    id                   TEXT PRIMARY KEY,
    private_model_id     TEXT NOT NULL,
    private_namespace    TEXT NOT NULL,
    private_name         TEXT NOT NULL,
    private_uri          TEXT NOT NULL,
    target_name          TEXT NOT NULL,
    target_collection_id TEXT NOT NULL DEFAULT '',
    requested_by         TEXT NOT NULL,
    note                 TEXT NOT NULL DEFAULT '',
    status               TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    reviewed_by          TEXT NOT NULL DEFAULT '',
    reviewer_note        TEXT NOT NULL DEFAULT '',
    catalog_model_id     TEXT NOT NULL DEFAULT '',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS knaic_publish_status ON knaic_publish_requests (status);
CREATE INDEX IF NOT EXISTS knaic_publish_ns ON knaic_publish_requests (private_namespace);
`

type PostgresStore struct {
	db *sqlx.DB
}

func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	db, err := sqlx.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pctx); err != nil {
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &PostgresStore{db: db}, nil
}

type row struct {
	ID                 string    `db:"id"`
	PrivateModelID     string    `db:"private_model_id"`
	PrivateNamespace   string    `db:"private_namespace"`
	PrivateName        string    `db:"private_name"`
	PrivateURI         string    `db:"private_uri"`
	TargetName         string    `db:"target_name"`
	TargetCollectionID string    `db:"target_collection_id"`
	RequestedBy        string    `db:"requested_by"`
	Note               string    `db:"note"`
	Status             string    `db:"status"`
	ReviewedBy         string    `db:"reviewed_by"`
	ReviewerNote       string    `db:"reviewer_note"`
	CatalogModelID     string    `db:"catalog_model_id"`
	CreatedAt          time.Time `db:"created_at"`
	UpdatedAt          time.Time `db:"updated_at"`
}

func (r row) toRequest() Request {
	return Request{
		ID:                 r.ID,
		PrivateModelID:     r.PrivateModelID,
		PrivateNamespace:   r.PrivateNamespace,
		PrivateName:        r.PrivateName,
		PrivateURI:         r.PrivateURI,
		TargetName:         r.TargetName,
		TargetCollectionID: r.TargetCollectionID,
		RequestedBy:        r.RequestedBy,
		Note:               r.Note,
		Status:             Status(r.Status),
		ReviewedBy:         r.ReviewedBy,
		ReviewerNote:       r.ReviewerNote,
		CatalogModelID:     r.CatalogModelID,
		CreatedAt:          r.CreatedAt,
		UpdatedAt:          r.UpdatedAt,
	}
}

func (s *PostgresStore) List(ctx context.Context, f ListFilter) ([]Request, error) {
	var rows []row
	q := `SELECT * FROM knaic_publish_requests
	      WHERE ($1 = '' OR status = $1)
	        AND ($2 = '' OR private_namespace = $2)
	      ORDER BY created_at DESC, id ASC`
	if err := s.db.SelectContext(ctx, &rows, q, string(f.Status), f.Namespace); err != nil {
		return nil, err
	}
	out := make([]Request, len(rows))
	for i, r := range rows {
		out[i] = r.toRequest()
	}
	return out, nil
}

func (s *PostgresStore) Get(ctx context.Context, id string) (Request, error) {
	var r row
	if err := s.db.GetContext(ctx, &r, `SELECT * FROM knaic_publish_requests WHERE id = $1`, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Request{}, ErrNotFound
		}
		return Request{}, err
	}
	return r.toRequest(), nil
}

func (s *PostgresStore) Create(ctx context.Context, r Request) (Request, error) {
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now().UTC()
	}
	if r.UpdatedAt.IsZero() {
		r.UpdatedAt = r.CreatedAt
	}
	q := `INSERT INTO knaic_publish_requests
	      (id, private_model_id, private_namespace, private_name, private_uri,
	       target_name, target_collection_id, requested_by, note, status,
	       reviewed_by, reviewer_note, catalog_model_id, created_at, updated_at)
	      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`
	_, err := s.db.ExecContext(ctx, q,
		r.ID, r.PrivateModelID, r.PrivateNamespace, r.PrivateName, r.PrivateURI,
		r.TargetName, r.TargetCollectionID, r.RequestedBy, r.Note, string(r.Status),
		r.ReviewedBy, r.ReviewerNote, r.CatalogModelID, r.CreatedAt, r.UpdatedAt,
	)
	if err != nil {
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return Request{}, ErrConflict
		}
		return Request{}, err
	}
	return r, nil
}

func (s *PostgresStore) Update(ctx context.Context, id string, mutate func(*Request) error) (Request, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return Request{}, err
	}
	defer tx.Rollback() //nolint:errcheck
	var r row
	if err := tx.GetContext(ctx, &r, `SELECT * FROM knaic_publish_requests WHERE id = $1 FOR UPDATE`, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Request{}, ErrNotFound
		}
		return Request{}, err
	}
	req := r.toRequest()
	if err := mutate(&req); err != nil {
		return Request{}, err
	}
	req.UpdatedAt = time.Now().UTC()
	_, err = tx.ExecContext(ctx,
		`UPDATE knaic_publish_requests SET
		   target_name=$1, target_collection_id=$2, note=$3, status=$4,
		   reviewed_by=$5, reviewer_note=$6, catalog_model_id=$7, updated_at=$8
		 WHERE id=$9`,
		req.TargetName, req.TargetCollectionID, req.Note, string(req.Status),
		req.ReviewedBy, req.ReviewerNote, req.CatalogModelID, req.UpdatedAt, req.ID,
	)
	if err != nil {
		return Request{}, err
	}
	if err := tx.Commit(); err != nil {
		return Request{}, err
	}
	return req, nil
}

func (s *PostgresStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM knaic_publish_requests WHERE id = $1`, id)
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
