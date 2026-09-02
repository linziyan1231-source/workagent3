package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type sharedTurnProjectResolver interface {
	ProjectRoot(context.Context, string) (string, error)
}

type sharedTurnRequest struct {
	RunID            string `json:"runId"`
	ConversationID   string `json:"conversationId"`
	ProjectID        string `json:"projectId"`
	Engine           string `json:"engine"`
	ModelID          string `json:"modelId"`
	ThinkingEffort   string `json:"thinkingEffort"`
	Context          string `json:"context"`
	RecoveryContext  string `json:"recoveryContext"`
	RuntimeSessionID string `json:"runtimeSessionId,omitempty"`
	PayerSID         string `json:"payerSid"`
	WorkspacePath    string `json:"workspacePath"`
}

func sharedTurnHandler(projects sharedTurnProjectResolver, target *url.URL, token string) http.HandlerFunc {
	client := &http.Client{}
	return func(writer http.ResponseWriter, request *http.Request) {
		var input sharedTurnRequest
		decoder := json.NewDecoder(io.LimitReader(request.Body, 800*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
			!sharedProjectIDPattern.MatchString(strings.TrimSpace(input.ProjectID)) ||
			!sharedProjectIDPattern.MatchString(strings.TrimSpace(input.ConversationID)) ||
			!sharedProjectIDPattern.MatchString(strings.TrimSpace(input.RunID)) ||
			(input.Engine != "harness" && input.Engine != "codex" && input.Engine != "kimi") ||
			strings.TrimSpace(input.ModelID) == "" || len(input.ModelID) > 256 ||
			(input.ThinkingEffort != "low" && input.ThinkingEffort != "medium" && input.ThinkingEffort != "high") ||
			strings.TrimSpace(input.Context) == "" || len(input.Context) > 512*1024 ||
			strings.TrimSpace(input.RecoveryContext) == "" || len(input.RecoveryContext) > 768*1024 ||
			!strings.HasPrefix(input.PayerSID, "S-1-") || len(input.PayerSID) > 128 {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_shared_turn")
			return
		}
		root, err := projects.ProjectRoot(request.Context(), input.ProjectID)
		if err != nil {
			writeRuntimeError(writer, http.StatusNotFound, "shared_project_not_found")
			return
		}
		input.WorkspacePath = root
		encoded, _ := json.Marshal(input)
		downstream, _ := http.NewRequestWithContext(request.Context(), http.MethodPost, target.ResolveReference(&url.URL{Path: "/v1/shared-turns"}).String(), bytes.NewReader(encoded))
		downstream.Header.Set("Authorization", "Bearer "+token)
		downstream.Header.Set("Content-Type", "application/json")
		response, err := client.Do(downstream)
		if err != nil {
			writeRuntimeError(writer, http.StatusBadGateway, "shared_turn_runtime_failed")
			return
		}
		defer response.Body.Close()
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(response.StatusCode)
		_, _ = io.Copy(writer, io.LimitReader(response.Body, 1024*1024))
	}
}

func sharedTurnCancelHandler(target *url.URL, token string) http.HandlerFunc {
	client := &http.Client{}
	return func(writer http.ResponseWriter, request *http.Request) {
		runID := strings.TrimSpace(request.PathValue("id"))
		if !sharedProjectIDPattern.MatchString(runID) {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_shared_turn")
			return
		}
		downstream, _ := http.NewRequestWithContext(request.Context(), http.MethodPost, target.ResolveReference(&url.URL{Path: "/v1/shared-turns/" + url.PathEscape(runID) + "/cancel"}).String(), nil)
		downstream.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(downstream)
		if err != nil {
			writeRuntimeError(writer, http.StatusBadGateway, "shared_turn_cancel_failed")
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			writeRuntimeError(writer, http.StatusBadGateway, "shared_turn_cancel_failed")
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	}
}
