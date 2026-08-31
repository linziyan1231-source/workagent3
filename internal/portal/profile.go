package portal

import (
	"encoding/json"
	"io"
	"net/http"

	"workagent3/internal/store"
)

func (s *Server) profile(writer http.ResponseWriter, _ *http.Request, user store.User) {
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "profile": user})
}

func (s *Server) updateProfile(writer http.ResponseWriter, request *http.Request, user store.User) {
	var input struct {
		DisplayName          string `json:"display_name"`
		CollaborationEnabled bool   `json:"collaboration_enabled"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		writeError(writer, http.StatusBadRequest, "invalid_profile")
		return
	}
	updated, err := s.store.UpdateProfile(request.Context(), user.ID, input.DisplayName, input.CollaborationEnabled)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_profile")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "profile": updated})
}
