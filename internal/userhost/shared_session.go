package userhost

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// sharedSessionBaseProvider exposes the shared-project base root
// (<base>/shared/<ownerSID>/<projectID>) to the session interceptor. The
// shared-file manager already holds the same base.
type sharedSessionBaseProvider interface {
	sharedBase() string
}

// sharedSessionHandler intercepts POST /v1/sessions so the browser can open an
// interactive session inside a collaboration project's shared folder by
// sending {"sharedProjectId": "..."}; the resolved absolute workspace path is
// computed server-side (clients never supply one, see shared_turn.go).
//
// The runtime token authenticates the employee's own runtime only — the
// gateway has no per-request user context — so project membership is not
// checked here. It is enforced by the Windows ACLs on the shared tree
// (members hold modify on the project root): a non-member's Harness process
// gets access-denied when it touches the folder.
func sharedSessionHandler(proxy http.Handler, sharedBase string) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, 1024*1024))
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_session_request")
			return
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(body, &fields) != nil {
			// Not a JSON object: nothing can be rewritten or stripped, so the
			// Harness applies its own validation to the original body.
			forwardSessionRequest(proxy, writer, request, body)
			return
		}
		// Clients never supply workspace paths; the server resolves them.
		delete(fields, "workspacePath")
		delete(fields, "workspace_path")
		projectID := ""
		if raw, ok := fields["sharedProjectId"]; ok {
			if json.Unmarshal(raw, &projectID) != nil {
				writeRuntimeError(writer, http.StatusBadRequest, "invalid_shared_project_id")
				return
			}
		}
		if projectID == "" {
			encoded, _ := json.Marshal(fields)
			forwardSessionRequest(proxy, writer, request, encoded)
			return
		}
		// The strict charset keeps separators and ".." away from the scan below.
		if !sharedProjectIDPattern.MatchString(projectID) {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_shared_project_id")
			return
		}
		if sharedBase == "" {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "shared_projects_unavailable")
			return
		}
		root, err := resolveSharedSessionRoot(sharedBase, projectID)
		if errors.Is(err, errSharedSessionNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "shared_project_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "shared_project_resolve_failed")
			return
		}
		delete(fields, "sharedProjectId")
		fields["workspace"], _ = json.Marshal("shared:" + projectID)
		fields["workspacePath"], _ = json.Marshal(root)
		encoded, _ := json.Marshal(fields)
		forwardSessionRequest(proxy, writer, request, encoded)
	}
}

func forwardSessionRequest(proxy http.Handler, writer http.ResponseWriter, request *http.Request, body []byte) {
	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	request.Header.Set("Content-Type", "application/json")
	proxy.ServeHTTP(writer, request)
}

var errSharedSessionNotFound = errors.New("shared project not found")

// resolveSharedSessionRoot scans <base>/shared/*/<projectID> (one level of
// owner-SID directories). Exactly one normal-directory match resolves; zero
// matches is not-found and several matches is a server-side inconsistency
// (project IDs are unique across owners).
func resolveSharedSessionRoot(sharedBase, projectID string) (string, error) {
	owners, err := os.ReadDir(filepath.Join(sharedBase, "shared"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", errSharedSessionNotFound
		}
		return "", err
	}
	root := ""
	for _, owner := range owners {
		if !owner.IsDir() || owner.Type()&os.ModeSymlink != 0 {
			continue
		}
		candidate := filepath.Join(sharedBase, "shared", owner.Name(), projectID)
		if requireNormalDirectory(candidate) != nil {
			continue
		}
		if root != "" {
			return "", errors.New("shared project id is not unique")
		}
		root = candidate
	}
	if root == "" {
		return "", errSharedSessionNotFound
	}
	return root, nil
}
