package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/alauda/knaic-backend/internal/components"
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if body == nil {
		return
	}
	_ = json.NewEncoder(w).Encode(body)
}

type apiError struct {
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, components.ErrNotFound):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
	}
}

func decodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}
