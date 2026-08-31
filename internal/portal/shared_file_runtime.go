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

type RuntimeSharedFilePlatform struct {
	runtimes runtimeapi.EmployeeRuntimeRouter
	client   *http.Client
}

func NewRuntimeSharedFilePlatform(runtimes runtimeapi.EmployeeRuntimeRouter) (*RuntimeSharedFilePlatform, error) {
	if runtimes == nil {
		return nil, errors.New("runtime router is required")
	}
	return &RuntimeSharedFilePlatform{runtimes: runtimes, client: &http.Client{Timeout: 30 * time.Second}}, nil
}

func (p *RuntimeSharedFilePlatform) Operate(ctx context.Context, ownerSID string, input SharedFileRequest) (json.RawMessage, error) {
	endpoint, err := p.runtimes.Resolve(ctx, ownerSID)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/internal/shared-files"})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	request.Header.Set("Content-Type", "application/json")
	setCorrelationHeader(request)
	response, err := p.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call owner Runtime shared-file service: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024))
		return nil, fmt.Errorf("owner Runtime shared-file service returned %d: %s", response.StatusCode, bytes.TrimSpace(message))
	}
	var result struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16*1024*1024))
	if decoder.Decode(&result) != nil || !result.Success || len(result.Data) == 0 {
		return nil, errors.New("owner Runtime shared-file response is invalid")
	}
	return result.Data, nil
}
