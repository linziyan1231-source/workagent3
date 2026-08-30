package userhost

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"workagent3/internal/mcpruntime"
)

func TestRuntimeGatewayOwnsMCPRoutesAndAuthenticates(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusTeapot)
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	handler := newRuntimeGatewayHandler(catalog, target, "runtime-token")

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/mcp-servers", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	body := `{"name":"docs","source":"user","enabled":true,"transport":{"kind":"http","url":"https://example.com/mcp","headerCredentialIds":{}},"toolPolicy":"all","allowedTools":[],"oauthState":"none"}`
	request := httptest.NewRequest(http.MethodPost, "/v1/mcp-servers", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer runtime-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || strings.Contains(response.Body.String(), "runtime-token") {
		t.Fatalf("create response %d: %s", response.Code, response.Body.String())
	}

	list := httptest.NewRequest(http.MethodGet, "/v1/mcp-servers", nil)
	list.Header.Set("Authorization", "Bearer runtime-token")
	listed := httptest.NewRecorder()
	handler.ServeHTTP(listed, list)
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"name":"docs"`) {
		t.Fatalf("list response %d: %s", listed.Code, listed.Body.String())
	}

	proxied := httptest.NewRequest(http.MethodGet, "/v1/conversations", nil)
	proxied.Header.Set("Authorization", "Bearer runtime-token")
	proxyResponse := httptest.NewRecorder()
	handler.ServeHTTP(proxyResponse, proxied)
	if proxyResponse.Code != http.StatusTeapot {
		t.Fatalf("fallback proxy status = %d", proxyResponse.Code)
	}
}

func TestRuntimeGatewayRejectsPlaintextMCPHeaders(t *testing.T) {
	catalog, _ := mcpruntime.Open(":memory:")
	defer catalog.Close()
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, target, "token")
	body := `{"name":"unsafe","source":"user","enabled":true,"transport":{"kind":"http","url":"https://example.com/mcp","headers":{"Authorization":"secret"}},"toolPolicy":"all","allowedTools":[],"oauthState":"none"}`
	request := httptest.NewRequest(http.MethodPost, "/v1/mcp-servers", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("plaintext header response %d: %s", response.Code, response.Body.String())
	}
}
