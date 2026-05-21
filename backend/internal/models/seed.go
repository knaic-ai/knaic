package models

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"

	"sigs.k8s.io/yaml"
)

//go:embed seed_default.yaml
var defaultSeedYAML []byte

// SeedCollection is the YAML shape for a collection in the seed file.
// Kept in this package (rather than referencing collections.Collection
// directly) so the import graph stays one-way: seed → models → collections.
type SeedCollection struct {
	ID          string `json:"id"          yaml:"id"`
	Name        string `json:"name"        yaml:"name"`
	Description string `json:"description" yaml:"description"`
	IconColor   string `json:"iconColor"   yaml:"iconColor"`
}

type seedFile struct {
	Collections []SeedCollection `json:"collections" yaml:"collections"`
	Models      []Model          `json:"models"      yaml:"models"`
}

// SeedBundle is what LoadPublicSeed now returns: models alongside the
// collections they reference. Both are loaded together so the IDs match.
type SeedBundle struct {
	Collections []SeedCollection
	Models      []Model
}

// LoadPublicSeed reads the public-scope seed list from a YAML file. If path
// is empty, the default list embedded into the binary is used. Defaults
// applied: scope=public, scheme=hf when omitted, SourceURL derived from URI.
func LoadPublicSeed(path string) (SeedBundle, error) {
	data := defaultSeedYAML
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return SeedBundle{}, fmt.Errorf("read public-models seed %s: %w", path, err)
		}
		data = b
	}
	var f seedFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return SeedBundle{}, fmt.Errorf("parse public-models seed: %w", err)
	}
	out := make([]Model, 0, len(f.Models))
	for _, m := range f.Models {
		m := m
		m.Scope = ScopePublic
		if m.Scheme == "" {
			m.Scheme = SchemeHF
		}
		if m.SourceURL == "" {
			m.SourceURL = PublicSourceURL(m.URI)
		}
		out = append(out, m)
	}
	return SeedBundle{Collections: f.Collections, Models: out}, nil
}

// Seed populates the public scope from the YAML seed list if the store is
// currently empty. Subsequent admin edits via the API are authoritative —
// Seed never overwrites them. Collections referenced from the bundle are
// applied via the supplied CollectionSeeder hook so this package stays
// independent of internal/collections.
type CollectionSeeder func(ctx context.Context, c SeedCollection) error

func Seed(ctx context.Context, s Store, path string, seedCollection CollectionSeeder) error {
	n, err := s.Count(ctx, ScopePublic)
	if err != nil || n > 0 {
		return err
	}
	bundle, err := LoadPublicSeed(path)
	if err != nil {
		return err
	}
	if seedCollection != nil {
		for _, c := range bundle.Collections {
			if err := seedCollection(ctx, c); err != nil {
				return err
			}
		}
	}
	for _, m := range bundle.Models {
		if m.ID == "" {
			m.ID = newID("m")
		}
		if _, err := s.Create(ctx, m); err != nil && err != ErrConflict {
			return err
		}
	}
	return nil
}

// newID returns a short random identifier. We avoid full UUIDs because the
// prototype already uses short ids in URLs and React keys.
func newID(prefix string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + hex.EncodeToString(b[:])
}
