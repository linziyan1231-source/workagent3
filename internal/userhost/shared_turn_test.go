package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/portal"
)

type sharedTurnProjectStub struct{ root string }

func (s sharedTurnProjectStub) ProjectRoot(context.Context, string) (string, error) {
	return s.root, nil
}

// TestSharedTurnHandlerAcceptsPortalWireRequest feeds the exact bytes the
// Portal marshals from portal.SharedTurnRequest into the UserHost handler, so
// a contract drift between the two halves is caught here instead of surfacing
// as a rejected shared AI run in production.
func TestSharedTurnHandlerAcceptsPortalWireRequest(t *testing.T) {
	root := filepath.Join(t.TempDir(), "shared", "S-1-5-21-1000", "project_1234567890")
	var forwarded []byte
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		forwarded, _ = io.ReadAll(request.Body)
		writeRuntimeJSON(writer, http.StatusOK, map[string]any{"runId": "run_1234567890123456", "runtimeSessionId": "session-shared", "assistantBody": "done", "recovered": false})
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	handler := sharedTurnHandler(sharedTurnProjectStub{root: root}, target, "runtime-token")

	wire, err := json.Marshal(portal.SharedTurnRequest{
		RunID: "run_1234567890123456", ConversationID: "conversation_123456", ProjectID: "project_1234567890",
		Engine: "codex", ModelID: "gpt-5", ThinkingEffort: "high",
		Context: "[Bob]\nPlease answer", RecoveryContext: "[Alice]\nhi\n[Bob]\nPlease answer",
		PayerSID:     "S-1-5-21-2000",
		SessionKey:   "session-shared-independent-assistant",
		QuotaModelID: "codex-native",
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/internal/shared-turns", bytes.NewReader(wire)))
	if response.Code != http.StatusOK {
		t.Fatalf("portal wire request rejected = %d %s", response.Code, response.Body.String())
	}
	var relayed map[string]any
	if err := json.Unmarshal(forwarded, &relayed); err != nil {
		t.Fatal(err)
	}
	if _, present := relayed["runtimeSessionId"]; present {
		t.Fatalf("first turn must omit runtimeSessionId: %s", forwarded)
	}
	if relayed["workspacePath"] != root || relayed["payerSid"] != "S-1-5-21-2000" || relayed["runId"] != "run_1234567890123456" || relayed["sessionKey"] != "session-shared-independent-assistant" || relayed["quotaModelId"] != "codex-native" {
		t.Fatalf("relayed request lost contract fields: %s", forwarded)
	}
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
