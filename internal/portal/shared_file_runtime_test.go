package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"workagent3/internal/runtimeapi"
)

func TestRuntimeSharedFilePlatformUsesOwnerRuntime(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/shared-files" || request.Header.Get("Authorization") != "Bearer owner-token" {
			t.Fatalf("request = %s, authorization = %q", request.URL.Path, request.Header.Get("Authorization"))
		}
		var input SharedFileRequest
		if json.NewDecoder(request.Body).Decode(&input) != nil || input.ProjectID != "project_1234567890" {
			t.Fatalf("input = %#v", input)
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "data": "content"})
	}))
	defer server.Close()
	registry := runtimeapi.NewRegistry()
	if err := registry.Register(runtimeapi.Registration{SID: "S-1-5-21-1000", BaseURL: server.URL, Token: "owner-token", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	platform, _ := NewRuntimeSharedFilePlatform(registry)
	data, err := platform.Operate(t.Context(), "S-1-5-21-1000", SharedFileRequest{ProjectID: "project_1234567890", Operation: "read", Path: "notes.md"})
	if err != nil || string(data) != `"content"` {
		t.Fatalf("result = %s, %v", data, err)
	}
}
