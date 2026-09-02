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
	"strings"
	"time"

	"workagent3/internal/contracts"
)

type EmployeeManagerClient struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewEmployeeManagerClient(rawURL, token string) (*EmployeeManagerClient, error) {
	endpoint, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.Path != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("Employee Manager URL must be an exact http://127.0.0.1:<port> origin")
	}
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("Employee Manager token is required")
	}
	return &EmployeeManagerClient{baseURL: strings.TrimSuffix(endpoint.String(), "/"), token: strings.TrimSpace(token), client: &http.Client{Timeout: 30 * time.Second}}, nil
}

func (c *EmployeeManagerClient) call(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	var payload []byte
	if input != nil {
		var err error
		payload, err = json.Marshal(input)
		if err != nil {
			return err
		}
		defer zeroBytes(payload)
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	// Propagate the acting administrator and the request correlation ID so
	// the Employee Manager attributes business audit events correctly. The
	// audit scope is present on every authenticated Portal request.
	if scope, ok := ctx.Value(auditContextKey{}).(*auditScope); ok {
		if scope.actor != "" {
			request.Header.Set("X-WorkAgent-Actor", scope.actor)
		}
		if scope.correlationID != "" {
			request.Header.Set(correlationHeader, scope.correlationID)
		}
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024))
		return fmt.Errorf("Employee Manager returned %s: %s", response.Status, strings.TrimSpace(string(message)))
	}
	if output == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(output)
}

func (c *EmployeeManagerClient) ListManagedUsers(ctx context.Context) ([]ManagedUser, []string, error) {
	var result struct {
		Users   []ManagedUser `json:"users"`
		Sources []string      `json:"kimi_datasource_sources"`
	}
	err := c.call(ctx, http.MethodGet, "/v1/users", nil, &result)
	return result.Users, result.Sources, err
}
func (c *EmployeeManagerClient) StartProvision(ctx context.Context, username string, password []byte) (ProvisionJob, error) {
	var result struct {
		Job ProvisionJob `json:"job"`
	}
	err := c.call(ctx, http.MethodPost, "/v1/users", map[string]string{"username": username, "portal_password": string(password)}, &result)
	return result.Job, err
}
func (c *EmployeeManagerClient) ProvisionJob(ctx context.Context, id string) (ProvisionJob, error) {
	var result struct {
		Job ProvisionJob `json:"job"`
	}
	err := c.call(ctx, http.MethodGet, "/v1/jobs?id="+url.QueryEscape(id), nil, &result)
	return result.Job, err
}
func (c *EmployeeManagerClient) ManagedUsersUsage(ctx context.Context) ([]ManagedUserUsage, error) {
	var result struct {
		Users []ManagedUserUsage `json:"users"`
	}
	err := c.call(ctx, http.MethodGet, "/v1/users/usage", nil, &result)
	return result.Users, err
}
func (c *EmployeeManagerClient) SetEnabled(ctx context.Context, username string, enabled bool) error {
	action := "disable"
	if enabled {
		action = "enable"
	}
	return c.call(ctx, http.MethodPost, "/v1/users/"+action, map[string]string{"username": username}, nil)
}
func (c *EmployeeManagerClient) ResetPassword(ctx context.Context, username string, password []byte) error {
	return c.call(ctx, http.MethodPost, "/v1/users/reset-password", map[string]string{"username": username, "portal_password": string(password)}, nil)
}
func (c *EmployeeManagerClient) Repair(ctx context.Context, username string, password []byte) error {
	return c.call(ctx, http.MethodPost, "/v1/users/repair", map[string]string{"username": username, "windows_password": string(password)}, nil)
}
func (c *EmployeeManagerClient) RenameWindowsAccount(ctx context.Context, username, newWindowsUsername string, password []byte) error {
	return c.call(ctx, http.MethodPost, "/v1/users/rename-windows", map[string]string{"username": username, "new_windows_username": newWindowsUsername, "windows_password": string(password)}, nil)
}
func (c *EmployeeManagerClient) SetLimits(ctx context.Context, username string, limits contracts.EmployeeResourceLimits) error {
	return c.call(ctx, http.MethodPost, "/v1/users/set-limits", map[string]any{"username": username, "limits": limits}, nil)
}
func (c *EmployeeManagerClient) OffboardRetain(ctx context.Context, username string) error {
	return c.call(ctx, http.MethodPost, "/v1/users/offboard-retain", map[string]string{"username": username}, nil)
}
func (c *EmployeeManagerClient) DeleteRetainedEmployee(ctx context.Context, username, confirmation string) error {
	return c.call(ctx, http.MethodPost, "/v1/users/offboard-delete", map[string]string{"username": username, "confirmation": confirmation}, nil)
}
func (c *EmployeeManagerClient) SetKimiDatasource(ctx context.Context, username string, grant KimiDatasourceGrant) (KimiDatasourceGrant, error) {
	var result contracts.KimiDatasourceGrant
	err := c.call(ctx, http.MethodPost, "/v1/users/kimi-datasource", map[string]any{"username": username, "grant": grant}, &result)
	return result, err
}

// ApplySharedProjectTransfer hands one cross-user shared-project transfer
// step to the SYSTEM-side Employee Manager, which owns the privileged
// filesystem work (move across owner roots, owner + protected DACL rewrite).
func (c *EmployeeManagerClient) ApplySharedProjectTransfer(ctx context.Context, projectID string, input sharedRuntimeRequest) error {
	return c.call(ctx, http.MethodPut, "/v1/shared-projects/"+url.PathEscape(projectID), input, nil)
}
