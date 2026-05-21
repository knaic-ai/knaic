package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/knaic/knaic-backend/internal/auth"
	"github.com/knaic/knaic-backend/internal/storage"
)

type storageAPI struct {
	store *storage.Store
}

func newStorageAPI(store *storage.Store) *storageAPI {
	return &storageAPI{store: store}
}

func (a *storageAPI) routes(r chi.Router) {
	// List is open to any authenticated user — every model upload / import
	// form needs to render the picker. Mutations are platform-admin only.
	r.Get("/targets", a.list)
	r.Group(func(r chi.Router) {
		r.Use(auth.RequirePlatformAdmin)
		r.Post("/targets", a.create)
		r.Patch("/targets/{id}", a.patch)
		r.Delete("/targets/{id}", a.remove)
	})
}

func (a *storageAPI) list(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.store.List())
}

func (a *storageAPI) create(w http.ResponseWriter, r *http.Request) {
	var in storage.CreateInput
	if err := decodeJSON(r, &in); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	t, err := a.store.Create(in)
	if err != nil {
		a.writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (a *storageAPI) patch(w http.ResponseWriter, r *http.Request) {
	var in storage.PatchInput
	if err := decodeJSON(r, &in); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	t, err := a.store.Patch(chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (a *storageAPI) remove(w http.ResponseWriter, r *http.Request) {
	if err := a.store.Delete(chi.URLParam(r, "id")); err != nil {
		a.writeStorageError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeStorageError maps the package's sentinel errors to the right HTTP
// status. Anything else falls through to a 400 because the only way it can
// happen today is validation failure inside Create.
func (a *storageAPI) writeStorageError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, storage.ErrNotFound):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	case errors.Is(err, storage.ErrBuiltinLocked):
		writeJSON(w, http.StatusForbidden, apiError{Error: err.Error()})
	case errors.Is(err, storage.ErrAlreadyExists):
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	}
}
