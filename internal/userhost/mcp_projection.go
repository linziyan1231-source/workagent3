package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
)

type projectionCredentialResolver interface {
	ResolveMCPValue(context.Context, string) ([]byte, error)
}

type mcpProjectionPublisher interface {
	Publish(context.Context) error
}

type harnessProjectionPublisher struct {
	catalog     *mcpruntime.Catalog
	credentials projectionCredentialResolver
	target      *url.URL
	token       string
	client      *http.Client
}

type harnessMCPProjection struct {
	Servers      []harnessResolvedMCPServer `json:"servers"`
	NativeNames  []string                   `json:"nativeNames"`
	NativeConfig map[string]map[string]any  `json:"nativeConfig"`
}

type harnessResolvedMCPServer struct {
	Server      mcpruntime.Server `json:"server"`
	Environment map[string]string `json:"environment"`
	Headers     map[string]string `json:"headers"`
	State       string            `json:"state"`
}

func (p *harnessProjectionPublisher) Publish(ctx context.Context) error {
	servers, err := p.catalog.List(ctx)
	if err != nil {
		return err
	}
	projection := harnessMCPProjection{Servers: make([]harnessResolvedMCPServer, 0, len(servers))}
	projection.NativeNames, err = p.catalog.NativeNames(ctx)
	if err != nil {
		return err
	}
	projection.NativeConfig, err = p.catalog.NativeConfig(ctx)
	if err != nil {
		return err
	}
	for _, server := range servers {
		resolved := harnessResolvedMCPServer{Server: server, Environment: map[string]string{}, Headers: map[string]string{}, State: "ready"}
		if !server.Enabled {
			resolved.State = "unavailable"
			projection.Servers = append(projection.Servers, resolved)
			continue
		}
		if server.OAuthState == "needs_auth" {
			resolved.State = "needs_auth"
			projection.Servers = append(projection.Servers, resolved)
			continue
		}
		if server.Health == "unavailable" || server.Health == "needs_review" {
			resolved.State = "unavailable"
			projection.Servers = append(projection.Servers, resolved)
			continue
		}
		if server.Transport.Kind == "stdio" {
			for name, id := range server.Transport.EnvironmentCredentialIDs {
				value, err := p.credentials.ResolveMCPValue(ctx, id)
				if err != nil {
					markProjectionCredentialFailure(&resolved, err)
					break
				}
				resolved.Environment[name] = string(value)
				clearBytes(value)
			}
		} else {
			for name, id := range server.Transport.HeaderCredentialIDs {
				value, err := p.credentials.ResolveMCPValue(ctx, id)
				if err != nil {
					markProjectionCredentialFailure(&resolved, err)
					break
				}
				resolved.Headers[name] = string(value)
				clearBytes(value)
			}
		}
		projection.Servers = append(projection.Servers, resolved)
	}
	body, err := json.Marshal(projection)
	clearProjectionSecrets(projection)
	if err != nil {
		return err
	}
	defer clearBytes(body)
	endpoint := p.target.ResolveReference(&url.URL{Path: "/internal/mcp-projection"})
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return fmt.Errorf("publish MCP projection: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("publish MCP projection: status %d: %s", response.StatusCode, message)
	}
	return nil
}

func markProjectionCredentialFailure(server *harnessResolvedMCPServer, err error) {
	server.Environment = map[string]string{}
	server.Headers = map[string]string{}
	if errors.Is(err, credentialbroker.ErrCredentialExpired) {
		server.State = "needs_auth"
		server.Server.OAuthState = "needs_auth"
		return
	}
	server.State = "unavailable"
	server.Server.Health = "unavailable"
}

func clearProjectionSecrets(projection harnessMCPProjection) {
	for _, server := range projection.Servers {
		for name := range server.Environment {
			server.Environment[name] = ""
		}
		for name := range server.Headers {
			server.Headers[name] = ""
		}
	}
}

func clearBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

var _ projectionCredentialResolver = (*credentialbroker.Store)(nil)
