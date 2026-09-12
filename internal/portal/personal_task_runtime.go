package portal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"workagent3/internal/collaboration"
	"workagent3/internal/runtimeapi"
)

type runtimePersonalTasks struct {
	runtimes runtimeapi.EmployeeRuntimeRouter
	client   *http.Client
}
type personalTaskRuntimeError struct {
	status int
	code   string
}

func (e *personalTaskRuntimeError) Error() string {
	return fmt.Sprintf("personal task runtime: %d %s", e.status, e.code)
}

func newRuntimePersonalTasks(runtimes runtimeapi.EmployeeRuntimeRouter) *runtimePersonalTasks {
	return &runtimePersonalTasks{runtimes, &http.Client{Timeout: 15 * time.Second}}
}
func (p *runtimePersonalTasks) Create(ctx context.Context, op collaboration.PersonalTaskOperation) (json.RawMessage, error) {
	// Replaying an already created operation must not depend on resolving a
	// project folder which may since have moved or disappeared.
	known, err := p.call(ctx, op.CreatorSID, http.MethodGet, "/v1/session-operations/"+url.PathEscape(op.ID), nil)
	if err == nil {
		var value struct {
			Operation struct {
				State string `json:"state"`
			} `json:"operation"`
			Session json.RawMessage `json:"session"`
		}
		if err = json.Unmarshal(known, &value); err != nil {
			return nil, err
		}
		if value.Operation.State == "deleted" || value.Operation.State == "deleting" {
			return nil, &personalTaskRuntimeError{409, "operation_deleted"}
		}
		if len(value.Session) > 0 {
			return value.Session, nil
		}
	} else if failure, ok := err.(*personalTaskRuntimeError); !ok || failure.status != 404 {
		return nil, err
	}
	var input map[string]any
	if err := json.Unmarshal(op.Configuration, &input); err != nil {
		return nil, err
	}
	input["operationId"], input["sharedProjectId"] = op.ID, op.ProjectID
	encoded, _ := json.Marshal(input)
	return p.call(ctx, op.CreatorSID, http.MethodPost, "/v1/sessions", encoded)
}
func (p *runtimePersonalTasks) Read(ctx context.Context, sid, id string) (json.RawMessage, error) {
	return p.call(ctx, sid, http.MethodGet, "/v1/sessions/"+url.PathEscape(id), nil)
}
func (p *runtimePersonalTasks) Delete(ctx context.Context, op collaboration.PersonalTaskOperation) error {
	path := "/v1/session-operations/" + url.PathEscape(op.ID)
	if string(op.Configuration) == "{}" {
		path = "/v1/sessions/" + url.PathEscape(op.RuntimeSessionID)
	}
	_, err := p.call(ctx, op.CreatorSID, http.MethodDelete, path, nil)
	if failure, ok := err.(*personalTaskRuntimeError); ok && failure.status == 404 {
		return nil
	}
	return err
}
func (p *runtimePersonalTasks) call(ctx context.Context, sid, method, path string, body []byte) (json.RawMessage, error) {
	endpoint, err := p.runtimes.Resolve(ctx, sid)
	if err != nil {
		return nil, err
	}
	r, _ := http.NewRequestWithContext(ctx, method, endpoint.BaseURL.ResolveReference(&url.URL{Path: path}).String(), bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+endpoint.Token)
	r.Header.Set("Content-Type", "application/json")
	setCorrelationHeader(r)
	response, err := p.client.Do(r)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(encoded, &failure)
		return nil, &personalTaskRuntimeError{response.StatusCode, failure.Error}
	}
	return encoded, nil
}
