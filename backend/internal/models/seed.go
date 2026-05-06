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

type seedFile struct {
	Models []Model `json:"models"`
}

// LoadPublicSeed reads the public-scope seed list from a YAML file. If path
// is empty, the default list embedded into the binary is used. Defaults
// applied: scope=public, scheme=hf when omitted.
func LoadPublicSeed(path string) ([]Model, error) {
	data := defaultSeedYAML
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read public-models seed %s: %w", path, err)
		}
		data = b
	}
	var f seedFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse public-models seed: %w", err)
	}
	out := make([]Model, 0, len(f.Models))
	for _, m := range f.Models {
		m := m
		m.Scope = ScopePublic
		if m.Scheme == "" {
			m.Scheme = SchemeHF
		}
		out = append(out, m)
	}
	return out, nil
}

// Seed populates the public scope from the YAML seed list if the store is
// currently empty. Subsequent admin edits via the API are authoritative —
// Seed never overwrites them.
func Seed(ctx context.Context, s Store, path string) error {
	n, err := s.Count(ctx, ScopePublic)
	if err != nil || n > 0 {
		return err
	}
	models, err := LoadPublicSeed(path)
	if err != nil {
		return err
	}
	for _, m := range models {
		m.ID = newID("m")
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
