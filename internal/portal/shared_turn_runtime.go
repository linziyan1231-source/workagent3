package portal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"workagent3/internal/runtimeapi"
)

type SharedTurnRequest struct {
	Capabilities     *projectCapabilities `json:"capabilities,omitempty"`
	QuotaModelID     string               `json:"quotaModelId,omitempty"`
	AssistantID      string               `json:"assistantId,omitempty"`
	RunID            string               `json:"runId"`
	ConversationID   string               `json:"conversationId"`
	ProjectID        string               `json:"projectId"`
	Engine           string               `json:"engine"`
	ModelID          string               `json:"modelId"`
	ThinkingEffort   string               `json:"thinkingEffort"`
	Context          string               `json:"context"`
	RecoveryContext  string               `json:"recoveryContext"`
	RuntimeSessionID string               `json:"runtimeSessionId,omitempty"`
	SessionKey       string               `json:"sessionKey,omitempty"`
	// PayerSID is the frozen triggerer SID the shared run is billed to; the
	// owner Runtime settles the reservation against it.
	PayerSID string `json:"payerSid"`
}

type SharedTurnResult struct {
	RunID            string `json:"runId"`
	RuntimeSessionID string `json:"runtimeSessionId"`
	AssistantBody    string `json:"assistantBody"`
	Recovered        bool   `json:"recovered"`
}

type SharedTurnRunner interface {
	Run(context.Context, string, SharedTurnRequest) (SharedTurnResult, error)
	Cancel(context.Context, string, string) error
}

type RuntimeSharedTurnRunner struct {
	runtimes runtimeapi.EmployeeRuntimeRouter
	client   *http.Client
}

func NewRuntimeSharedTurnRunner(runtimes runtimeapi.EmployeeRuntimeRouter) (*RuntimeSharedTurnRunner, error) {
	if runtimes == nil {
		return nil, errors.New("runtime router is required")
	}
	return &RuntimeSharedTurnRunner{runtimes: runtimes, client: &http.Client{Timeout: 30 * time.Minute}}, nil
}

func (r *RuntimeSharedTurnRunner) Run(ctx context.Context, ownerSID string, input SharedTurnRequest) (SharedTurnResult, error) {
	endpoint, err := r.runtimes.Resolve(ctx, ownerSID)
	if err != nil {
		return SharedTurnResult{}, err
	}
	encoded, _ := json.Marshal(input)
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.BaseURL.ResolveReference(&url.URL{Path: "/internal/shared-turns"}).String(), bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	request.Header.Set("Content-Type", "application/json")
	setCorrelationHeader(request)
	response, err := r.client.Do(request)
	if err != nil {
		return SharedTurnResult{}, fmt.Errorf("call owner Runtime shared-turn service: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024))
		return SharedTurnResult{}, fmt.Errorf("owner Runtime shared-turn service returned %d: %s", response.StatusCode, bytes.TrimSpace(message))
	}
	var result SharedTurnResult
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1024*1024))
	if decoder.Decode(&result) != nil || result.RunID != input.RunID || result.RuntimeSessionID == "" || result.AssistantBody == "" {
		return SharedTurnResult{}, errors.New("owner Runtime shared-turn response is invalid")
	}
	return result, nil
}

func (r *RuntimeSharedTurnRunner) Cancel(ctx context.Context, ownerSID, runID string) error {
	endpoint, err := r.runtimes.Resolve(ctx, ownerSID)
	if err != nil {
		return err
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/internal/shared-turns/" + url.PathEscape(runID) + "/cancel"})
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), nil)
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	response, err := r.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return errors.New("owner Runtime shared-turn cancellation failed")
	}
	return nil
}
