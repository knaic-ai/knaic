package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/registry"
)

type registryAPI struct {
	store *registry.Store
}

func newRegistryAPI(store *registry.Store) *registryAPI {
	return &registryAPI{store: store}
}

func (a *registryAPI) routes(r chi.Router) {
	r.Get("/", a.get)
	r.Patch("/", a.patch)
	r.Post("/sync", a.sync)
}

func (a *registryAPI) get(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.store.Get())
}

func (a *registryAPI) patch(w http.ResponseWriter, r *http.Request) {
	var p registry.Patch
	if err := decodeJSON(r, &p); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, a.store.Apply(p))
}

func (a *registryAPI) sync(w http.ResponseWriter, r *http.Request) {
	// The actual mirror is performed by an out-of-process script that
	// posts back to /api/v1/registry to update counters. The button-press
	// path simply optimistically marks everything synced.
	writeJSON(w, http.StatusOK, a.store.MarkAllSynced())
}
