// Package registry stores the configuration of the built-in image registry
// that knaic uses to mirror component images. The actual OCI registry process
// is built and shipped separately (see build/sync-images.sh); this package
// only owns the configuration and per-image sync state surfaced to the UI.
package registry

import (
	"sync"
	"time"
)

type Config struct {
	Endpoint     string `json:"endpoint"`
	Username     string `json:"username"`
	Project      string `json:"project"`
	UseBuiltin   bool   `json:"useBuiltin"`
	TotalImages  int    `json:"totalImages"`
	SyncedImages int    `json:"syncedImages"`
	DiskUsageGiB int    `json:"diskUsageGi"`
	CapacityGiB  int    `json:"capacityGi"`
	LastSyncedAt string `json:"lastSyncedAt,omitempty"`
}

type Store struct {
	mu  sync.RWMutex
	cur Config
}

func New(endpoint, project string, useBuiltin bool) *Store {
	return &Store{
		cur: Config{
			Endpoint:     endpoint,
			Username:     "knaic",
			Project:      project,
			UseBuiltin:   useBuiltin,
			TotalImages:  24,
			SyncedImages: 0,
			DiskUsageGiB: 0,
			CapacityGiB:  512,
		},
	}
}

func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

// Patch applies a partial update; nil fields on the patch struct are ignored.
type Patch struct {
	Endpoint   *string `json:"endpoint,omitempty"`
	Username   *string `json:"username,omitempty"`
	Project    *string `json:"project,omitempty"`
	UseBuiltin *bool   `json:"useBuiltin,omitempty"`
}

func (s *Store) Apply(p Patch) Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Endpoint != nil {
		s.cur.Endpoint = *p.Endpoint
	}
	if p.Username != nil {
		s.cur.Username = *p.Username
	}
	if p.Project != nil {
		s.cur.Project = *p.Project
	}
	if p.UseBuiltin != nil {
		s.cur.UseBuiltin = *p.UseBuiltin
	}
	return s.cur
}

// MarkAllSynced is the synchronous part of the sync action: it flips the
// counters as if every image was successfully mirrored. The actual mirror
// work is delegated to an out-of-process script.
func (s *Store) MarkAllSynced() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cur.SyncedImages = s.cur.TotalImages
	s.cur.LastSyncedAt = time.Now().UTC().Format(time.RFC3339)
	return s.cur
}

// SetTotals refreshes counters based on the current set of components and
// their image lists. Called by the components service whenever a chart is
// imported or removed, so the UI never shows a stale total.
func (s *Store) SetTotals(total int) Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cur.TotalImages = total
	if s.cur.SyncedImages > total {
		s.cur.SyncedImages = total
	}
	return s.cur
}
