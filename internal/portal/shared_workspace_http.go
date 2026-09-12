package portal

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"

	"workagent3/internal/store"
)

var sharedUploadCommitMu sync.Mutex

// Project membership is checked on every chunk, download and completion. Only
// the owner's authenticated runtime resolves filesystem paths.
func (s *Server) sharedWorkspaceHTTP(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(w, 503, "collaboration_unavailable")
		return
	}
	project, err := s.modules.Collaboration.ProjectForUser(r.Context(), r.PathValue("id"), user.ID, true)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	if project.State != "active" {
		writeError(w, 409, "shared_project_busy")
		return
	}
	rest := r.PathValue("rest")
	resource := strings.Split(rest, "/")[0]
	if resource == "trash" {
		s.sharedTrashHTTP(w, r, project)
		return
	}
	if resource == "content" && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodDelete {
		writeError(w, 405, "use_resumable_upload")
		return
	}
	if resource != "uploads" && resource != "files" && resource != "content" && resource != "directories" && resource != "move" && resource != "locate" {
		writeError(w, 404, "not_found")
		return
	}
	endpoint, err := s.runtimes.Resolve(r.Context(), project.OwnerSID)
	if err != nil {
		writeError(w, 503, "shared_files_unavailable")
		return
	}
	target := "/v1/shared-workspaces/" + url.PathEscape(project.ID) + "/" + rest
	if r.Method == http.MethodPost && resource == "uploads" {
		sharedUploadCommitMu.Lock()
		defer sharedUploadCommitMu.Unlock()
		var size int64
		if rest == "uploads" {
			body, err := io.ReadAll(io.LimitReader(r.Body, 16*1024))
			if err != nil {
				writeError(w, 400, "invalid_upload")
				return
			}
			var input struct {
				Size int64 `json:"size"`
			}
			if json.Unmarshal(body, &input) != nil || input.Size < 0 || input.Size > 5*1024*1024*1024 {
				writeError(w, 413, "request_too_large")
				return
			}
			size = input.Size
			r.Body = io.NopCloser(bytes.NewReader(body))
		} else if strings.HasSuffix(rest, "/complete") {
			probe, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, endpoint.BaseURL.ResolveReference(&url.URL{Path: strings.TrimSuffix(target, "/complete")}).String(), nil)
			probe.Header.Set("Authorization", "Bearer "+endpoint.Token)
			response, err := http.DefaultClient.Do(probe)
			if err != nil {
				writeError(w, 503, "shared_files_unavailable")
				return
			}
			var upload struct {
				Size      int64           `json:"size"`
				Completed json.RawMessage `json:"completed"`
			}
			err = json.NewDecoder(io.LimitReader(response.Body, 16*1024)).Decode(&upload)
			response.Body.Close()
			if err != nil || response.StatusCode != 200 {
				writeError(w, 404, "upload_not_found")
				return
			}
			size = upload.Size
			if len(upload.Completed) > 0 {
				size = 0
			}
		}
		if s.modules.Storage == nil {
			writeError(w, 503, "storage_unavailable")
			return
		}
		usage, err := s.modules.Storage.StorageUsage(r.Context(), project.OwnerSID)
		if err != nil {
			writeError(w, 503, "storage_unavailable")
			return
		}
		if usage.Shared.Enabled && size > usage.Shared.LimitBytes-usage.Shared.UsedBytes {
			writeError(w, 413, "shared_storage_exceeded")
			return
		}
	}
	proxy := httputil.NewSingleHostReverseProxy(endpoint.BaseURL)
	director := proxy.Director
	proxy.Director = func(out *http.Request) {
		director(out)
		out.URL.Path = target
		out.URL.RawPath = ""
		out.Header.Del("Cookie")
		out.Header.Set("Authorization", "Bearer "+endpoint.Token)
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		writeError(w, 502, "shared_file_operation_failed")
	}
	proxy.ServeHTTP(w, r)
}
