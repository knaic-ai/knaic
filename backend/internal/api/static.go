package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// staticHandler serves the React build at rootDir with SPA fallback semantics:
// any request that doesn't resolve to an existing file is rewritten to
// index.html so client-side routing (react-router) keeps working on a hard
// reload.
//
// Returns nil when rootDir is empty or doesn't contain index.html — chi's
// NotFound stays in place and unknown paths get a plain 404. This means the
// same binary works in two modes: API-only (rootDir empty) for the local
// dev workflow, and bundled UI (rootDir set, populated by the Docker build)
// for the deployed image.
func staticHandler(rootDir string) http.Handler {
	if rootDir == "" {
		return nil
	}
	indexPath := filepath.Join(rootDir, "index.html")
	if info, err := os.Stat(indexPath); err != nil || info.IsDir() {
		return nil
	}
	fileServer := http.FileServer(http.Dir(rootDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// API + probe paths are registered before this handler in
		// NewRouter, so they should never reach here. Belt-and-braces:
		// reject explicitly so a misroute can't accidentally serve
		// index.html in place of a JSON 404.
		if strings.HasPrefix(r.URL.Path, "/api/") ||
			r.URL.Path == "/healthz" ||
			r.URL.Path == "/readyz" {
			http.NotFound(w, r)
			return
		}
		// Resolve the requested path against rootDir and refuse to escape
		// the bundle directory. filepath.Join cleans `..`, but we still
		// double-check the resolved path stays inside rootDir.
		clean := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/")
		full := filepath.Join(rootDir, clean)
		if rel, err := filepath.Rel(rootDir, full); err != nil || strings.HasPrefix(rel, "..") {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Anything else — unknown route, missing file, directory listing —
		// falls back to index.html so the SPA boots and resolves the route
		// client-side.
		http.ServeFile(w, r, indexPath)
	})
}
