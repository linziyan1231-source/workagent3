package portal

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"workagent3/internal/collaboration"
	"workagent3/internal/store"
)

// Shared Office previews convert on the project owner's UserHost through the
// shared-files forwarding channel (RuntimeSharedFilePlatform) and are served
// here with the same read-only inline + CSP policy as workspace PDF previews.

func (s *Server) sharedOfficePreviewProject(writer http.ResponseWriter, request *http.Request, user store.User, projectID string) (ownerSID string, ok bool) {
	if s.modules.Collaboration == nil || s.modules.SharedFiles == nil {
		writeError(writer, http.StatusServiceUnavailable, "shared_files_unavailable")
		return "", false
	}
	project, err := s.modules.Collaboration.ProjectForUser(request.Context(), projectID, user.ID, true)
	if errors.Is(err, collaboration.ErrNotFound) {
		writeError(writer, http.StatusNotFound, "shared_project_not_found")
		return "", false
	}
	if err != nil {
		writeError(writer, http.StatusForbidden, "shared_project_forbidden")
		return "", false
	}
	if project.State != "active" {
		writeError(writer, http.StatusConflict, "shared_project_busy")
		return "", false
	}
	return project.OwnerSID, true
}

func writeOfficePreviewUpstreamError(writer http.ResponseWriter, err error) {
	var upstream *upstreamRuntimeError
	if errors.As(err, &upstream) && upstream.code != "" {
		status := upstream.status
		if status < 400 || status > 599 {
			status = http.StatusBadGateway
		}
		writeError(writer, status, upstream.code)
		return
	}
	writeError(writer, http.StatusBadGateway, "shared_file_operation_failed")
}

func (s *Server) sharedOfficePreview(writer http.ResponseWriter, request *http.Request, user store.User) {
	request.Body = http.MaxBytesReader(writer, request.Body, 64*1024)
	var input struct {
		ProjectID string `json:"project_id"`
		Path      string `json:"path"`
	}
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		writeError(writer, http.StatusBadRequest, "invalid_shared_file_request")
		return
	}
	input.ProjectID = strings.TrimSpace(input.ProjectID)
	input.Path = strings.TrimSpace(input.Path)
	if input.ProjectID == "" || input.Path == "" || len(input.Path) > 4096 {
		writeError(writer, http.StatusBadRequest, "invalid_shared_file_request")
		return
	}
	ownerSID, ok := s.sharedOfficePreviewProject(writer, request, user, input.ProjectID)
	if !ok {
		return
	}
	if _, err := s.modules.SharedFiles.OperateOfficePreview(request.Context(), ownerSID, SharedFileRequest{ProjectID: input.ProjectID, Operation: "office-preview", Path: input.Path}); err != nil {
		writeOfficePreviewUpstreamError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true,
		"url":     "/api/portal/shared-office-preview?project_id=" + url.QueryEscape(input.ProjectID) + "&path=" + url.QueryEscape(input.Path),
	})
}

func (s *Server) sharedOfficePreviewContent(writer http.ResponseWriter, request *http.Request, user store.User) {
	projectID := strings.TrimSpace(request.URL.Query().Get("project_id"))
	path := request.URL.Query().Get("path")
	if projectID == "" || path == "" || len(path) > 4096 {
		writeError(writer, http.StatusBadRequest, "invalid_shared_file_request")
		return
	}
	ownerSID, ok := s.sharedOfficePreviewProject(writer, request, user, projectID)
	if !ok {
		return
	}
	data, err := s.modules.SharedFiles.OperateOfficePreview(request.Context(), ownerSID, SharedFileRequest{ProjectID: projectID, Operation: "office-preview", Path: path})
	if err != nil {
		writeOfficePreviewUpstreamError(writer, err)
		return
	}
	writer.Header().Set("cache-control", "no-store")
	writer.Header().Set("content-disposition", "inline; filename*=UTF-8''"+url.PathEscape(data.Name))
	writer.Header().Set("content-type", "application/pdf")
	writer.Header().Set("content-security-policy", "default-src 'none'; frame-ancestors 'self'; base-uri 'none'")
	writer.Header().Set("content-length", strconv.Itoa(len(data.PDF)))
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(data.PDF)
}
