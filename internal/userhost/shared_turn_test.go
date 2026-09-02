package userhost

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

type sharedTurnProjectStub struct{ root string }

func (s sharedTurnProjectStub) ProjectRoot(context.Context, string) (string, error) {
	return s.root, nil
}

func TestSharedTurnHandlerInjectsOwnerRuntimeProjectRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "shared", "S-1-5-21-1000", "project_1234567890")
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/shared-turns" || request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Fatalf("request = %s auth=%q", request.URL.Path, request.Header.Get("Authorization"))
		}
		var input sharedTurnRequest
		if json.NewDecoder(request.Body).Decode(&input) != nil || input.WorkspacePath != root || input.PayerSID != "S-1-5-21-2000" {
			t.Fatalf("input = %#v", input)
		}
		writeRuntimeJSON(writer, http.StatusOK, map[string]any{"runId": input.RunID, "runtimeSessionId": "session-shared", "assistantBody": "done", "recovered": false})
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	handler := sharedTurnHandler(sharedTurnProjectStub{root: root}, target, "runtime-token")
	body := `{"runId":"run_1234567890123456","conversationId":"conversation_123456","projectId":"project_1234567890","engine":"codex","modelId":"gpt-5","thinkingEffort":"high","context":"delta","recoveryContext":"full","payerSid":"S-1-5-21-2000"}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/internal/shared-turns", strings.NewReader(body)))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"assistantBody":"done"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
