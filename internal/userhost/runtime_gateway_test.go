package userhost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillruntime"
)

type gatewayTestProtector struct{}
type gatewayTestPublisher struct{}

func (gatewayTestPublisher) Publish(context.Context) error { return nil }

func (gatewayTestProtector) Seal(value []byte) ([]byte, error) {
	return append([]byte("sealed:"), value...), nil
}

func (gatewayTestProtector) Open(value []byte) ([]byte, error) {
	return append([]byte(nil), value[len("sealed:"):]...), nil
}

func openGatewayCredentials(t *testing.T) *credentialbroker.Store {
	t.Helper()
	store, err := credentialbroker.Open(filepath.Join(t.TempDir(), "credentials.db"), gatewayTestProtector{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func openGatewaySkills(t *testing.T) *skillruntime.Store {
	t.Helper()
	root := t.TempDir()
	store, err := skillruntime.Open(filepath.Join(root, "skills.db"), filepath.Join(root, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

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
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, target, "runtime-token")

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
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, target, "token")
	body := `{"name":"unsafe","source":"user","enabled":true,"transport":{"kind":"http","url":"https://example.com/mcp","headers":{"Authorization":"secret"}},"toolPolicy":"all","allowedTools":[],"oauthState":"none"}`
	request := httptest.NewRequest(http.MethodPost, "/v1/mcp-servers", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("plaintext header response %d: %s", response.Code, response.Body.String())
	}
}

func TestRuntimeGatewayListsMetadataAndAcceptsCredentialReferences(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	credentials := openGatewayCredentials(t)
	_, err = credentials.Put(context.Background(), credentialbroker.Input{
		ID: "header-1", Kind: credentialbroker.KindMCPHeader, Label: "Docs authorization", Secret: []byte("Bearer private"), State: credentialbroker.StateReady,
	})
	if err != nil {
		t.Fatal(err)
	}
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v1/credentials" {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`[{"id":"codex-native","kind":"codex_native","state":"needs_auth","label":"Codex","updatedAt":null}]`))
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	handler := newRuntimeGatewayHandler(catalog, credentials, gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, target, "token")

	statusRequest := httptest.NewRequest(http.MethodGet, "/v1/credentials", nil)
	statusRequest.Header.Set("Authorization", "Bearer token")
	statusResponse := httptest.NewRecorder()
	handler.ServeHTTP(statusResponse, statusRequest)
	if statusResponse.Code != http.StatusOK || !strings.Contains(statusResponse.Body.String(), `"id":"header-1"`) || strings.Contains(statusResponse.Body.String(), "Bearer private") {
		t.Fatalf("credential response %d: %s", statusResponse.Code, statusResponse.Body.String())
	}

	body := `{"name":"docs","source":"user","enabled":true,"transport":{"kind":"http","url":"https://example.com/mcp","headerCredentialIds":{"Authorization":"header-1"}},"toolPolicy":"all","allowedTools":[],"oauthState":"none"}`
	request := httptest.NewRequest(http.MethodPost, "/v1/mcp-servers", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("credential reference response %d: %s", response.Code, response.Body.String())
	}
}
