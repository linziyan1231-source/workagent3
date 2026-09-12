package portal

import (
	"bytes"
	"context"
	"encoding/base64"
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

// upstreamRuntimeError preserves the owner Runtime's error code so Portal can
// relay stable codes (for example OFFICECLI_NOT_FOUND) to the browser.
type upstreamRuntimeError struct {
	status int
	code   string
}

func (e *upstreamRuntimeError) Error() string {
	return fmt.Sprintf("owner Runtime shared-file service returned %d: %s", e.status, e.code)
}

func (p *RuntimeSharedFilePlatform) call(ctx context.Context, ownerSID string, input SharedFileRequest) (json.RawMessage, error) {
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
	client := *p.client
	if input.Operation == "remove" {
		client.Timeout = 150 * time.Second
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call owner Runtime shared-file service: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error string `json:"error"`
		}
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024))
		code := string(bytes.TrimSpace(message))
		if json.Unmarshal(message, &failure) == nil && failure.Error != "" {
			code = failure.Error
		}
		return nil, &upstreamRuntimeError{status: response.StatusCode, code: code}
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

func (p *RuntimeSharedFilePlatform) Operate(ctx context.Context, ownerSID string, input SharedFileRequest) (json.RawMessage, error) {
	return p.call(ctx, ownerSID, input)
}

func (p *RuntimeSharedFilePlatform) OperateOfficePreview(ctx context.Context, ownerSID string, input SharedFileRequest) (OfficePreviewData, error) {
	input.Operation = "office-preview"
	raw, err := p.call(ctx, ownerSID, input)
	if err != nil {
		return OfficePreviewData{}, err
	}
	var payload struct {
		Name string `json:"name"`
		PDF  string `json:"pdf"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Name == "" || payload.PDF == "" {
		return OfficePreviewData{}, errors.New("owner Runtime office preview response is invalid")
	}
	decoded, err := base64.StdEncoding.DecodeString(payload.PDF)
	if err != nil {
		return OfficePreviewData{}, errors.New("owner Runtime office preview payload is invalid")
	}
	return OfficePreviewData{Name: payload.Name, PDF: decoded}, nil
}
