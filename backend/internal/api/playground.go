package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/alauda/knaic-backend/internal/auth"
	"github.com/alauda/knaic-backend/internal/playground"
)

type playgroundAPI struct {
	svc             *playground.Service
	agentAPIBaseURL string
}

func newPlaygroundAPI(svc *playground.Service, agentAPIBaseURL string) *playgroundAPI {
	return &playgroundAPI{svc: svc, agentAPIBaseURL: strings.TrimRight(agentAPIBaseURL, "/")}
}

func (a *playgroundAPI) routes(r chi.Router) {
	r.Route("/playground", func(r chi.Router) {
		r.Get("/providers", a.listProviders)
		r.Post("/providers", a.createProvider)
		r.Patch("/providers/{id}", a.patchProvider)
		r.Delete("/providers/{id}", a.deleteProvider)
		r.Post("/chat", a.chat)
		r.Post("/chat/stream", a.streamChat)
		r.Get("/agent/sessions", a.listAgentSessions)
		r.Post("/agent/sessions", a.createAgentSession)
		r.Get("/agent/sessions/{id}", a.getAgentSession)
		r.Delete("/agent/sessions/{id}", a.deleteAgentSession)
		r.Post("/agent/sessions/{id}/run", a.runAgent)
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

func (a *playgroundAPI) listAgentSessions(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	items, err := a.svc.ListAgentSessions(r.Context(), u, r.URL.Query().Get("namespace"))
	if err != nil {
		writePlaygroundError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *playgroundAPI) createAgentSession(w http.ResponseWriter, r *http.Request) {
	var req playground.CreateAgentSessionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	u := auth.MustFromContext(r.Context())
	session, err := a.svc.CreateAgentSession(r.Context(), u, req)
	if err != nil {
		writePlaygroundError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, session)
}

func (a *playgroundAPI) getAgentSession(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	session, err := a.svc.GetAgentSession(r.Context(), u, chi.URLParam(r, "id"))
	if err != nil {
		writePlaygroundError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (a *playgroundAPI) deleteAgentSession(w http.ResponseWriter, r *http.Request) {
	u := auth.MustFromContext(r.Context())
	if err := a.svc.DeleteAgentSession(r.Context(), u, chi.URLParam(r, "id")); err != nil {
		writePlaygroundError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *playgroundAPI) runAgent(w http.ResponseWriter, r *http.Request) {
	var req playground.AgentRunRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "streaming unsupported"})
		return
	}
	u := auth.MustFromContext(r.Context())
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	emit := func(ev playground.AgentEvent) {
		raw, _ := json.Marshal(ev)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
		flusher.Flush()
	}
	err := a.svc.RunAgent(
		r.Context(),
		u,
		chi.URLParam(r, "id"),
		req,
		playground.AgentRunContext{
			APIBaseURL: a.baseURL(r),
			UserToken:  r.Header.Get("Authorization"),
			Namespace:  r.URL.Query().Get("namespace"),
		},
		emit,
	)
	if err != nil {
		emit(playground.AgentEvent{Kind: "error", Text: err.Error()})
	}
	_, _ = fmt.Fprint(w, "event: end\ndata: \n\n")
	flusher.Flush()
}

func (a *playgroundAPI) baseURL(r *http.Request) string {
	if a.agentAPIBaseURL != "" {
		return a.agentAPIBaseURL
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if xf := r.Header.Get("X-Forwarded-Proto"); xf != "" {
		scheme = xf
	}
	return scheme + "://" + r.Host
}

func writePlaygroundError(w http.ResponseWriter, err error) {
	if errors.Is(err, playground.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
}
