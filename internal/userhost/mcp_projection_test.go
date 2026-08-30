package userhost

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
)

func TestHarnessProjectionResolvesCredentialsOnlyAcrossPrivateRoute(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	credentials := openGatewayCredentials(t)
	_, err = credentials.Put(context.Background(), credentialbroker.Input{
		ID: "header-1", Kind: credentialbroker.KindMCPHeader, Label: "Authorization", Secret: []byte("Bearer private"), State: credentialbroker.StateReady,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = catalog.Create(context.Background(), mcpruntime.Server{
		ID: "docs", Name: "Docs", Source: "user", Enabled: true,
		Transport:  mcpruntime.Transport{Kind: "http", URL: "https://example.com/mcp", HeaderCredentialIDs: map[string]string{"Authorization": "header-1"}},
		ToolPolicy: "all", AllowedTools: []string{}, OAuthState: "none", Health: "healthy",
	})
	if err != nil {
		t.Fatal(err)
	}
	var received string
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/mcp-projection" || request.Method != http.MethodPut || request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Fatalf("unexpected projection request %s %s", request.Method, request.URL.Path)
		}
		body, _ := io.ReadAll(request.Body)
		received = string(body)
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	publisher := &harnessProjectionPublisher{
		catalog: catalog, credentials: credentials, target: target, token: "runtime-token", client: &http.Client{Timeout: time.Second},
	}
	if err := publisher.Publish(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(received, `"Authorization":"Bearer private"`) || !strings.Contains(received, `"headerCredentialIds":{"Authorization":"header-1"}`) {
		t.Fatalf("projection did not contain resolved private data: %s", received)
	}
	if err := credentials.Revoke(context.Background(), "header-1"); err != nil {
		t.Fatal(err)
	}
	if err := publisher.Publish(context.Background()); err != nil {
		t.Fatalf("one revoked credential blocked the complete projection: %v", err)
	}
	if !strings.Contains(received, `"state":"needs_auth"`) || strings.Contains(received, "Bearer private") {
		t.Fatalf("revoked projection did not fail only its server: %s", received)
	}

	handler := newRuntimeGatewayHandler(catalog, credentials, publisher, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "runtime-token")
	request := httptest.NewRequest(http.MethodPut, "/internal/mcp-projection", strings.NewReader(`{"servers":[]}`))
	request.Header.Set("Authorization", "Bearer runtime-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("external private route status = %d", response.Code)
	}
}
