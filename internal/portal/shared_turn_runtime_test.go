package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"workagent3/internal/runtimeapi"
)

func TestRuntimeSharedTurnRunnerUsesFrozenOwnerRuntime(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/shared-turns" || request.Header.Get("Authorization") != "Bearer owner-token" {
			t.Fatalf("request = %s, authorization = %q", request.URL.Path, request.Header.Get("Authorization"))
		}
		var input SharedTurnRequest
		if json.NewDecoder(request.Body).Decode(&input) != nil || input.RunID != "run_1234567890123456" {
			t.Fatalf("input = %#v", input)
		}
		writeJSON(writer, http.StatusOK, SharedTurnResult{RunID: input.RunID, RuntimeSessionID: "session-shared-conversation_123456", AssistantBody: "done"})
	}))
	defer server.Close()
	registry := runtimeapi.NewRegistry()
	if err := registry.Register(runtimeapi.Registration{SID: "S-1-5-21-1000", BaseURL: server.URL, Token: "owner-token", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	runner, _ := NewRuntimeSharedTurnRunner(registry)
	result, err := runner.Run(t.Context(), "S-1-5-21-1000", SharedTurnRequest{RunID: "run_1234567890123456", ConversationID: "conversation_123456", ProjectID: "project_1234567890", Engine: "codex", ModelID: "gpt-5", ThinkingEffort: "high", Context: "delta", RecoveryContext: "full"})
	if err != nil || result.AssistantBody != "done" {
		t.Fatalf("result = %#v, %v", result, err)
	}
}
