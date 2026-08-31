package portal

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"workagent3/internal/collaboration"
	"workagent3/internal/store"
)

const maxSharedFilePayload = 8 * 1024 * 1024

func (s *Server) sharedFiles(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil || s.modules.SharedFiles == nil {
		writeError(writer, http.StatusServiceUnavailable, "shared_files_unavailable")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxSharedFilePayload+16*1024)
	var input SharedFileRequest
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		writeError(writer, http.StatusBadRequest, "invalid_shared_file_request")
		return
	}
	input.ProjectID = strings.TrimSpace(input.ProjectID)
	input.Operation = strings.TrimSpace(input.Operation)
	allowed := map[string]bool{"dir": true, "list": true, "metadata": true, "read": true, "read-buffer": true, "image-base64": true, "write": true, "remove": true, "rename": true}
	if !allowed[input.Operation] || len(input.Path) > 4096 || len(input.NewName) > 255 || len(input.Data) > maxSharedFilePayload {
		writeError(writer, http.StatusBadRequest, "invalid_shared_file_request")
		return
	}
	project, err := s.modules.Collaboration.ProjectForUser(request.Context(), input.ProjectID, user.ID, true)
	if errors.Is(err, collaboration.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "shared_project_not_found")
		return
	}
	if err != nil {
		writeError(writer, http.StatusForbidden, "shared_project_forbidden")
		return
	}
	if project.State != "active" {
		writeError(writer, http.StatusConflict, "shared_project_busy")
		return
	}
	data, err := s.modules.SharedFiles.Operate(request.Context(), project.OwnerSID, input)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "shared_file_operation_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "data": data})
}
