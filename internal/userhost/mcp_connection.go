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
	"os"
	"os/exec"
	"strings"
	"time"

	"workagent3/internal/mcpruntime"
)

type mcpConnectionResult struct {
	Success bool              `json:"success"`
	Server  mcpruntime.Server `json:"server"`
	Error   string            `json:"error,omitempty"`
}

type mcpProcessAssigner interface {
	AssignPID(uint32) error
}

func testMCPConnection(catalog *mcpruntime.Catalog, credentials projectionCredentialResolver, publisher mcpProjectionPublisher, assigners ...mcpProcessAssigner) http.HandlerFunc {
	var assigner mcpProcessAssigner
	if len(assigners) > 0 {
		assigner = assigners[0]
	}
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
		testErr := initializeMCP(request.Context(), server, credentials, assigner)
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

func initializeMCP(ctx context.Context, server mcpruntime.Server, credentials projectionCredentialResolver, assigner mcpProcessAssigner) error {
	switch server.Transport.Kind {
	case "stdio":
		return initializeStdioMCP(ctx, server, credentials, assigner)
	case "http":
		return initializeHTTPMCP(ctx, server, credentials)
	default:
		return fmt.Errorf("mcp_connection_test_unsupported:%s", server.Transport.Kind)
	}
}

func initializeStdioMCP(ctx context.Context, server mcpruntime.Server, credentials projectionCredentialResolver, assigner mcpProcessAssigner) error {
	if !server.Enabled {
		return errors.New("mcp_server_disabled")
	}
	if server.OAuthState == "needs_auth" {
		return errors.New("mcp_needs_auth")
	}
	environment := make(map[string]string, len(server.Transport.EnvironmentCredentialIDs))
	defer func() {
		for name := range environment {
			environment[name] = ""
		}
	}()
	for name, id := range server.Transport.EnvironmentCredentialIDs {
		secret, err := credentials.ResolveMCPValue(ctx, id)
		if err != nil {
			return errors.New("mcp_needs_auth")
		}
		environment[name] = string(secret)
		clearBytes(secret)
	}
	operation, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	command := exec.CommandContext(operation, server.Transport.Command, server.Transport.Args...)
	command.Env = stdioMCPEnvironment(environment)
	stdin, err := command.StdinPipe()
	if err != nil {
		return errors.New("mcp_connection_failed")
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return errors.New("mcp_connection_failed")
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return errors.New("mcp_connection_failed")
	}
	if err := command.Start(); err != nil {
		return errors.New("mcp_connection_failed")
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	go func() { _, _ = io.Copy(io.Discard, stderr) }()
	if assigner != nil {
		if err := assigner.AssignPID(uint32(command.Process.Pid)); err != nil {
			_ = command.Process.Kill()
			<-done
			return errors.New("mcp_process_sandbox_failed")
		}
	}
	payload, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{
			"protocolVersion": "2025-03-26", "capabilities": map[string]any{},
			"clientInfo": map[string]string{"name": "WorkAgent3", "version": "0.1.0"},
		},
	})
	if _, err := stdin.Write(append(payload, '\n')); err != nil {
		_ = command.Process.Kill()
		<-done
		return errors.New("mcp_connection_failed")
	}
	result := make(chan error, 1)
	go func() { result <- readStdioInitialize(stdout) }()
	var testErr error
	processExited := false
	select {
	case testErr = <-result:
	case <-operation.Done():
		testErr = errors.New("mcp_connection_failed")
	case <-done:
		processExited = true
		testErr = <-result
	}
	_ = stdin.Close()
	if !processExited {
		_ = command.Process.Kill()
		<-done
	}
	return testErr
}

func readStdioInitialize(stdout io.Reader) error {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		var message struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Result  json.RawMessage `json:"result"`
			Error   json.RawMessage `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &message) == nil && message.JSONRPC == "2.0" && string(bytes.TrimSpace(message.ID)) == "1" {
			if rawJSONEmpty(message.Result) || !rawJSONEmpty(message.Error) {
				return errors.New("mcp_initialize_invalid")
			}
			return nil
		}
	}
	return errors.New("mcp_initialize_invalid")
}

func stdioMCPEnvironment(values map[string]string) []string {
	allowed := map[string]struct{}{
		"SystemRoot": {}, "WINDIR": {}, "PATH": {}, "PATHEXT": {}, "TEMP": {}, "TMP": {}, "ComSpec": {},
		"XDG_CACHE_HOME": {}, "npm_config_cache": {}, "PIP_CACHE_DIR": {}, "UV_CACHE_DIR": {}, "PYTHONPYCACHEPREFIX": {},
		"LOCALAPPDATA": {}, "APPDATA": {}, "USERPROFILE": {}, "USERNAME": {}, "HOME": {},
	}
	environment := make([]string, 0, len(allowed)+len(values))
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		overridden := false
		for providedName := range values {
			if strings.EqualFold(name, providedName) {
				overridden = true
				break
			}
		}
		if overridden {
			continue
		}
		for allowedName := range allowed {
			if strings.EqualFold(name, allowedName) {
				environment = append(environment, value)
				break
			}
		}
	}
	for name, value := range values {
		environment = append(environment, name+"="+value)
	}
	return environment
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
		secret, err := credentials.ResolveMCPValue(ctx, id)
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
