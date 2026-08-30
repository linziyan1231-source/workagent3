package userhost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
)

func TestRuntimeGatewayTestsStreamableHTTPMCP(t *testing.T) {
	var authorization string
	mcpServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"test","version":"1"}}}`))
	}))
	defer mcpServer.Close()
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	credentials := openGatewayCredentials(t)
	_, err = credentials.Put(context.Background(), credentialbroker.Input{
		ID: "auth", Kind: credentialbroker.KindMCPHeader, Label: "Authorization", Secret: []byte("Bearer private"), State: credentialbroker.StateReady,
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := catalog.Create(context.Background(), mcpruntime.Server{
		ID: "managed-local", Name: "Managed local", Source: "managed", Enabled: true,
		Transport:  mcpruntime.Transport{Kind: "http", URL: mcpServer.URL, HeaderCredentialIDs: map[string]string{"Authorization": "auth"}},
		ToolPolicy: "all", AllowedTools: []string{}, OAuthState: "none", Health: "unknown",
	})
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, credentials, gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "token")
	request := httptest.NewRequest(http.MethodPost, "/v1/mcp-servers/"+created.ID+"/test", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"success":true`) {
		t.Fatalf("test response %d: %s", response.Code, response.Body.String())
	}
	if authorization != "Bearer private" {
		t.Fatalf("credential reference was not resolved: %q", authorization)
	}
	updated, err := catalog.Get(context.Background(), created.ID)
	if err != nil || updated.Health != "healthy" {
		t.Fatalf("healthy result not persisted: %#v, %v", updated, err)
	}
}

func TestRuntimeGatewayReportsUnsupportedMCPTest(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	created, err := catalog.Create(context.Background(), mcpruntime.Server{
		ID: "stdio", Name: "Stdio", Source: "managed", Enabled: true,
		Transport:  mcpruntime.Transport{Kind: "stdio", Command: `C:\\managed\\server.exe`, Args: []string{}, EnvironmentCredentialIDs: map[string]string{}},
		ToolPolicy: "all", AllowedTools: []string{}, OAuthState: "none", Health: "unknown",
	})
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "token")
	request := httptest.NewRequest(http.MethodPost, "/v1/mcp-servers/"+created.ID+"/test", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"success":false`) || !strings.Contains(response.Body.String(), "mcp_connection_test_unsupported:stdio") {
		t.Fatalf("unsupported response %d: %s", response.Code, response.Body.String())
	}
}
