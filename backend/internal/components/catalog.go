package components

import (
	_ "embed"
	"fmt"
	"os"

	"sigs.k8s.io/yaml"
)

//go:embed catalog_default.yaml
var defaultCatalogYAML []byte

type catalogFile struct {
	Components []Component `json:"components"`
}

// LoadCatalog reads the component catalog from a YAML file. If path is empty,
// the default catalog embedded in the binary is used.
func LoadCatalog(path string) ([]Component, error) {
	data := defaultCatalogYAML
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read catalog %s: %w", path, err)
		}
		data = b
	}
	var f catalogFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse catalog: %w", err)
	}
	out := make([]Component, 0, len(f.Components))
	for _, c := range f.Components {
		c := c
		// Default fields the YAML doesn't set.
		c.Status = StatusNotInstalled
		c.ImageSync = SyncPending
		c.Builtin = true
		out = append(out, c)
	}
	return out, nil
}
