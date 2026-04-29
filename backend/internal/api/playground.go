package api

import (
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/playground"
)

type playgroundAPI struct {
	svc *playground.Service
}

func newPlaygroundAPI(svc *playground.Service) *playgroundAPI {
	return &playgroundAPI{svc: svc}
}

func (a *playgroundAPI) routes(r chi.Router) {
	r.Route("/playground", func(r chi.Router) {
		r.Get("/providers", a.listProviders)
		r.Post("/providers", a.createProvider)
		r.Patch("/providers/{id}", a.patchProvider)
		r.Delete("/providers/{id}", a.deleteProvider)
		r.Post("/chat", a.chat)
		r.Post("/chat/stream", a.streamChat)
	})
}

func (a *playgroundAPI) listProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.svc.ListProviders(r.Context(), r.URL.Query().Get("namespace")))
}

func (a *playgroundAPI) createProvider(w http.ResponseWriter, r *http.Request) {
	var req playground.ProviderRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	p, err := a.svc.CreateProvider(r.Context(), req)
	if err != nil {
		writePlaygroundError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (a *playgroundAPI) patchProvider(w http.ResponseWriter, r *http.Request) {
	var patch playground.ProviderPatch
	if err := decodeJSON(r, &patch); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	p, err := a.svc.PatchProvider(r.Context(), chi.URLParam(r, "id"), patch)
	if err != nil {
		writePlaygroundError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (a *playgroundAPI) deleteProvider(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.DeleteProvider(r.Context(), chi.URLParam(r, "id")); err != nil {
		writePlaygroundError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *playgroundAPI) chat(w http.ResponseWriter, r *http.Request) {
	var req playground.ChatRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	resp, err := a.svc.Chat(r.Context(), req)
	if err != nil {
		writePlaygroundError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *playgroundAPI) streamChat(w http.ResponseWriter, r *http.Request) {
	var req playground.ChatRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	stream, err := a.svc.StreamChat(r.Context(), req)
	if err != nil {
		writePlaygroundError(w, err)
		return
	}
	defer stream.Body.Close()
	w.Header().Set("Content-Type", stream.ContentType)
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, stream.Body)
}

func writePlaygroundError(w http.ResponseWriter, err error) {
	if errors.Is(err, playground.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
}
