package portal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
)

// SharedTrashPort keeps cross-owner retention in the privileged manager. The
// Portal supplies the current owner only after checking project membership.
type SharedTrashPort interface {
	OperateSharedTrash(context.Context, string, contracts.SharedTrashRequest) (json.RawMessage, error)
}

type sharedTrashResponseError struct {
	status int
	code   string
}

func (e *sharedTrashResponseError) Error() string { return e.code }

func (c *EmployeeManagerClient) OperateSharedTrash(ctx context.Context, projectID string, input contracts.SharedTrashRequest) (json.RawMessage, error) {
	payload, _ := json.Marshal(input)
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/shared-trash/"+url.PathEscape(projectID), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Authorization", "Bearer "+c.token)
	r.Header.Set("Content-Type", "application/json")
	client := *c.client
	// A Store callback outlives its initiating browser request. Wait for the
	// central move to finish so its file identity is retired only after commit.
	client.Timeout = 0
	response, err := client.Do(r)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var result struct {
			Error string `json:"error"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result) != nil || result.Error == "" {
			result.Error = "shared_trash_unavailable"
		}
		return nil, &sharedTrashResponseError{status: response.StatusCode, code: result.Error}
	}
	var result json.RawMessage
	err = json.NewDecoder(response.Body).Decode(&result)
	return result, err
}

func (s *Server) sharedTrashHTTP(w http.ResponseWriter, r *http.Request, project collaboration.Project) {
	parts := strings.Split(r.PathValue("rest"), "/")
	input := contracts.SharedTrashRequest{OwnerSID: project.OwnerSID}
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		input.Operation = "list"
	case len(parts) == 3 && parts[1] != "" && parts[2] == "restore" && r.Method == http.MethodPost:
		input.Operation, input.EntryID = "restore", parts[1]
	case len(parts) == 2 && parts[1] != "" && r.Method == http.MethodDelete:
		input.Operation, input.EntryID = "purge", parts[1]
	default:
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	s.operateSharedTrash(w, r, project.ID, input)
}

func (s *Server) operateSharedTrash(w http.ResponseWriter, r *http.Request, projectID string, input contracts.SharedTrashRequest) {
	if s.modules.SharedTrash == nil {
		writeError(w, http.StatusServiceUnavailable, "shared_trash_unavailable")
		return
	}
	result, err := s.modules.SharedTrash.OperateSharedTrash(r.Context(), projectID, input)
	if err != nil {
		var failure *sharedTrashResponseError
		if errors.As(err, &failure) {
			writeError(w, failure.status, failure.code)
		} else {
			writeError(w, http.StatusBadGateway, "shared_trash_unavailable")
		}
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// SharedTrashRuntimeHandler accepts the same SID-bound Platform credential as
// runtime quota and project capabilities. Neither SID nor projectID alone grants
// access; membership is rechecked for list, recycle and every restoration.
func (s *Server) SharedTrashRuntimeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !runtimeapi.IsLoopbackRequest(r) {
			writeError(w, http.StatusForbidden, "loopback_required")
			return
		}
		var input struct {
			SID       string `json:"sid"`
			ProjectID string `json:"projectId"`
			Operation string `json:"operation"`
			Path      string `json:"path,omitempty"`
			EntryID   string `json:"entryId,omitempty"`
			Source    string `json:"source,omitempty"`
		}
		if r.Method != http.MethodPost || !decodeJSON(r, &input, 8192) {
			writeError(w, http.StatusBadRequest, "invalid_shared_trash_request")
			return
		}
		credential, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !s.store.RuntimeRegistrationAuthorized(r.Context(), input.SID, credential) {
			writeError(w, http.StatusUnauthorized, "registration_rejected")
			return
		}
		user, err := s.store.UserBySID(r.Context(), input.SID)
		if err != nil || user.Disabled || user.Offboarded {
			writeError(w, http.StatusForbidden, "employee_unavailable")
			return
		}
		if s.modules.Collaboration == nil {
			writeError(w, http.StatusServiceUnavailable, "collaboration_unavailable")
			return
		}
		project, err := s.modules.Collaboration.ProjectForUser(r.Context(), input.ProjectID, user.ID, true)
		if err != nil {
			writeCollaborationError(w, err)
			return
		}
		if project.State != "active" {
			writeError(w, http.StatusConflict, "shared_project_busy")
			return
		}
		if input.Source != "" && (input.Source != "workspace-store" || user.SID != project.OwnerSID || input.Operation != "recycle") {
			writeError(w, http.StatusForbidden, "shared_trash_source_forbidden")
			return
		}
		if input.Operation == "recycle" && input.Source == "" {
			s.recycleThroughSharedWorkspace(w, r, project, input.Path)
			return
		}
		s.operateSharedTrash(w, r, project.ID, contracts.SharedTrashRequest{
			OwnerSID: project.OwnerSID, Operation: input.Operation, Path: input.Path, EntryID: input.EntryID,
		})
	})
}

// All controlled deletions pass through the owner's WorkspaceStore, which
// resolves file identities and records the deletion before acknowledging it.
// Its callback uses the owner-only source marker to reach the central pool.
func (s *Server) recycleThroughSharedWorkspace(w http.ResponseWriter, r *http.Request, project collaboration.Project, path string) {
	endpoint, err := s.runtimes.Resolve(r.Context(), project.OwnerSID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "shared_files_unavailable")
		return
	}
	path = strings.TrimPrefix(path, "shared://"+project.ID+"/")
	target := endpoint.BaseURL.ResolveReference(&url.URL{
		Path:     "/v1/shared-workspaces/" + project.ID + "/content",
		RawQuery: url.Values{"path": {path}}.Encode(),
	})
	forward, err := http.NewRequestWithContext(r.Context(), http.MethodDelete, target.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_shared_trash_request")
		return
	}
	forward.Header.Set("Authorization", "Bearer "+endpoint.Token)
	response, err := (&http.Client{Timeout: 150 * time.Second}).Do(forward)
	if err != nil {
		writeError(w, http.StatusBadGateway, "shared_trash_unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var result struct {
			Error string `json:"error"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result) != nil || result.Error == "" {
			result.Error = "shared_trash_unavailable"
		}
		writeError(w, response.StatusCode, result.Error)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"recycled": true})
}
