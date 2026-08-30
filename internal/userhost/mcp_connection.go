package userhost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"workagent3/internal/mcpruntime"
)

type mcpConnectionResult struct {
	Success bool              `json:"success"`
	Server  mcpruntime.Server `json:"server"`
	Error   string            `json:"error,omitempty"`
}

func testMCPConnection(catalog *mcpruntime.Catalog, credentials projectionCredentialResolver, publisher mcpProjectionPublisher) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		server, err := catalog.Get(request.Context(), request.PathValue("id"))
		if errors.Is(err, mcpruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "mcp_server_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		testErr := initializeHTTPMCP(request.Context(), server, credentials)
		if testErr == nil {
			server.Health = "healthy"
		} else {
			server.Health = "unavailable"
		}
		server, err = catalog.Replace(request.Context(), server)
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "mcp_projection_failed")
			return
		}
		result := mcpConnectionResult{Success: testErr == nil, Server: server}
		if testErr != nil {
			result.Error = testErr.Error()
		}
		writeRuntimeJSON(writer, http.StatusOK, result)
	}
}

func initializeHTTPMCP(ctx context.Context, server mcpruntime.Server, credentials projectionCredentialResolver) error {
	if !server.Enabled {
		return errors.New("mcp_server_disabled")
	}
	if server.OAuthState == "needs_auth" {
		return errors.New("mcp_needs_auth")
	}
	if server.Transport.Kind != "http" {
		return fmt.Errorf("mcp_connection_test_unsupported:%s", server.Transport.Kind)
	}
	endpoint, err := url.Parse(server.Transport.URL)
	if err != nil {
		return errors.New("invalid_mcp_endpoint")
	}
	headers := make(map[string]string, len(server.Transport.HeaderCredentialIDs))
	defer func() {
		for name := range headers {
			headers[name] = ""
		}
	}()
	for name, id := range server.Transport.HeaderCredentialIDs {
		secret, err := credentials.Resolve(ctx, id)
		if err != nil {
			return errors.New("mcp_needs_auth")
		}
		headers[name] = string(secret)
		clearBytes(secret)
	}
	payload, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{
			"protocolVersion": "2025-03-26", "capabilities": map[string]any{},
			"clientInfo": map[string]string{"name": "WorkAgent3", "version": "0.1.0"},
		},
	})
	operation, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	httpRequest, err := http.NewRequestWithContext(operation, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return errors.New("invalid_mcp_endpoint")
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json, text/event-stream")
	for name, value := range headers {
		httpRequest.Header.Set(name, value)
	}
	client := &http.Client{
		Transport:     &http.Transport{DialContext: guardedMCPDialer(server.Source == "managed")},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("mcp_redirect_rejected") },
		Timeout:       15 * time.Second,
	}
	response, err := client.Do(httpRequest)
	if err != nil {
		return errors.New("mcp_connection_failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("mcp_http_status:%d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return errors.New("mcp_response_invalid")
	}
	if strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		body = firstSSEData(body)
	}
	var message struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if json.Unmarshal(body, &message) != nil || message.JSONRPC != "2.0" || string(bytes.TrimSpace(message.ID)) != "1" || rawJSONEmpty(message.Result) || !rawJSONEmpty(message.Error) {
		return errors.New("mcp_initialize_invalid")
	}
	return nil
}

func rawJSONEmpty(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

func firstSSEData(body []byte) []byte {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		line := scanner.Text()
		if value, ok := strings.CutPrefix(line, "data:"); ok {
			return []byte(strings.TrimSpace(value))
		}
	}
	return nil
}

func guardedMCPDialer(allowManagedLoopback bool) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.New("invalid_mcp_endpoint")
		}
		addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(addresses) == 0 {
			return nil, errors.New("mcp_dns_failed")
		}
		for _, candidate := range addresses {
			ip := candidate.Unmap()
			if forbiddenMCPAddress(ip) && !(allowManagedLoopback && ip.IsLoopback()) {
				return nil, errors.New("mcp_private_endpoint_rejected")
			}
		}
		dialer := net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
		return dialer.DialContext(ctx, network, net.JoinHostPort(addresses[0].String(), port))
	}
}

func forbiddenMCPAddress(ip netip.Addr) bool {
	return !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
}
