package userhost

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type capturedSessionRequest struct {
	called bool
	body   map[string]json.RawMessage
}

func newSharedSessionGateway(t *testing.T, sharedFiles sharedFileOperator) (http.Handler, *capturedSessionRequest) {
	t.Helper()
	captured := &capturedSessionRequest{}
	harness := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/sessions" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		raw, _ := io.ReadAll(request.Body)
		captured.called = true
		if json.Unmarshal(raw, &captured.body) != nil {
			captured.body = map[string]json.RawMessage{"__raw__": raw}
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"id":"session-1"}`))
	}))
	t.Cleanup(harness.Close)
	target, _ := url.Parse(harness.URL)
	handler := newRuntimeGatewayHandlerWithControl(nil, nil, nil, nil, nil, nil, nil, target, "runtime-token", nil, sharedFiles, nil, "", nil, nil, nil, "")
	return handler, captured
}

func postSharedSession(t *testing.T, handler http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/v1/sessions", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer runtime-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestSharedSessionPassthroughStripsWorkspacePath(t *testing.T) {
	handler, captured := newSharedSessionGateway(t, &sharedFileManager{base: t.TempDir()})
	response := postSharedSession(t, handler, `{"name":"demo","workspacePath":"C:/evil","workspace_path":"/evil","options":{"k":1}}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("passthrough status = %d: %s", response.Code, response.Body.String())
	}
	if !captured.called {
		t.Fatal("harness was not called")
	}
	if _, ok := captured.body["workspacePath"]; ok {
		t.Fatalf("workspacePath was forwarded: %v", captured.body)
	}
	if _, ok := captured.body["workspace_path"]; ok {
		t.Fatalf("workspace_path was forwarded: %v", captured.body)
	}
	if _, ok := captured.body["workspace"]; ok {
		t.Fatalf("workspace must not be injected without sharedProjectId: %v", captured.body)
	}
	var name string
	if json.Unmarshal(captured.body["name"], &name) != nil || name != "demo" {
		t.Fatalf("name field lost: %v", captured.body)
	}
}

func TestSharedSessionResolvesSharedProject(t *testing.T) {
	base := t.TempDir()
	projectID := "abcdef0123456789"
	expectedRoot := filepath.Join(base, "shared", "S-1-5-21-1000", projectID)
	if err := os.MkdirAll(expectedRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	handler, captured := newSharedSessionGateway(t, &sharedFileManager{base: base})
	response := postSharedSession(t, handler, `{"sharedProjectId":"`+projectID+`","name":"demo","workspacePath":"C:/evil"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("shared session status = %d: %s", response.Code, response.Body.String())
	}
	if !captured.called {
		t.Fatal("harness was not called")
	}
	if _, ok := captured.body["sharedProjectId"]; ok {
		t.Fatalf("sharedProjectId must be removed: %v", captured.body)
	}
	if _, ok := captured.body["workspace_path"]; ok {
		t.Fatalf("workspace_path was forwarded: %v", captured.body)
	}
	var workspace, workspacePath, name string
	if json.Unmarshal(captured.body["workspace"], &workspace) != nil || workspace != "shared:"+projectID {
		t.Fatalf("workspace = %q, want shared:%s", workspace, projectID)
	}
	if json.Unmarshal(captured.body["workspacePath"], &workspacePath) != nil || workspacePath != expectedRoot {
		t.Fatalf("workspacePath = %q, want %q", workspacePath, expectedRoot)
	}
	if json.Unmarshal(captured.body["name"], &name) != nil || name != "demo" {
		t.Fatalf("name field lost: %v", captured.body)
	}
}

func TestSharedSessionNotFound(t *testing.T) {
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "shared", "S-1-5-21-1000"), 0o700); err != nil {
		t.Fatal(err)
	}
	handler, captured := newSharedSessionGateway(t, &sharedFileManager{base: base})
	response := postSharedSession(t, handler, `{"sharedProjectId":"abcdef0123456789","name":"demo"}`)
	if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "shared_project_not_found") {
		t.Fatalf("not-found status = %d: %s", response.Code, response.Body.String())
	}
	if captured.called {
		t.Fatal("harness must not be called for a missing project")
	}
}

func TestSharedSessionRejectsBadID(t *testing.T) {
	handler, captured := newSharedSessionGateway(t, &sharedFileManager{base: t.TempDir()})
	for _, id := range []string{"../escape", "a/b", `a\b`, "short", "has space", "abcdef0123456789/.."} {
		response := postSharedSession(t, handler, `{"sharedProjectId":"`+strings.ReplaceAll(id, `\`, `\\`)+`"}`)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("id %q: status = %d: %s", id, response.Code, response.Body.String())
		}
	}
	if captured.called {
		t.Fatal("harness must not be called for an invalid project id")
	}
}

func TestSharedSessionUnavailableWithoutSharedBase(t *testing.T) {
	handler, captured := newSharedSessionGateway(t, nil)
	response := postSharedSession(t, handler, `{"sharedProjectId":"abcdef0123456789"}`)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	if captured.called {
		t.Fatal("harness must not be called when shared projects are disabled")
	}
}
