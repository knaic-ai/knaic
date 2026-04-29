// Package charts embeds the built-in Helm charts shipped with knaic.
//
// Each chart lives under data/<name>/... and follows the standard Helm
// chart layout. Use Load to obtain a parsed *chart.Chart ready to install.
package charts

import (
	"embed"
	"fmt"
	"io/fs"
	"path"
	"strings"

	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chart/loader"
)

//go:embed all:data
var fsys embed.FS

// Names lists every embedded chart directory.
func Names() ([]string, error) {
	entries, err := fsys.ReadDir("data")
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// Has reports whether a chart with the given name is embedded.
func Has(name string) bool {
	_, err := fsys.ReadDir(path.Join("data", name))
	return err == nil
}

// Load reads the embedded chart with the given name into a *chart.Chart
// so it can be passed to action.Install or action.Upgrade.
func Load(name string) (*chart.Chart, error) {
	root := path.Join("data", name)
	if _, err := fsys.ReadDir(root); err != nil {
		return nil, fmt.Errorf("chart %q not found: %w", name, err)
	}

	var files []*loader.BufferedFile
	walkErr := fs.WalkDir(fsys, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fsys.ReadFile(p)
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, root), "/")
		files = append(files, &loader.BufferedFile{Name: rel, Data: data})
		return nil
	})
	if walkErr != nil {
		return nil, fmt.Errorf("walk chart %q: %w", name, walkErr)
	}
	chrt, err := loader.LoadFiles(files)
	if err != nil {
		return nil, fmt.Errorf("load chart %q: %w", name, err)
	}
	return chrt, nil
}
