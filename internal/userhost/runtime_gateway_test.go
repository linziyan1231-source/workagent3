package userhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillmigration"
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
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "runtime-token")

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
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "token")
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
	handler := newRuntimeGatewayHandler(catalog, credentials, gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "token")

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

func TestRuntimeGatewayCreatesAndRevokesMCPSecrets(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	credentials := openGatewayCredentials(t)
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, credentials, gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "token")

	request := httptest.NewRequest(http.MethodPost, "/v1/credentials", strings.NewReader(`{"kind":"mcp_header","label":"Authorization","secret":"Bearer private"}`))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || strings.Contains(response.Body.String(), "Bearer private") {
		t.Fatalf("create credential response %d: %s", response.Code, response.Body.String())
	}
	var metadata credentialbroker.Metadata
	if err := json.Unmarshal(response.Body.Bytes(), &metadata); err != nil {
		t.Fatal(err)
	}
	secret, err := credentials.Resolve(context.Background(), metadata.ID)
	if err != nil || string(secret) != "Bearer private" {
		t.Fatalf("credential was not protected: %q, %v", secret, err)
	}
	clearBytes(secret)

	revoke := httptest.NewRequest(http.MethodDelete, "/v1/credentials/"+metadata.ID, nil)
	revoke.Header.Set("Authorization", "Bearer token")
	revoked := httptest.NewRecorder()
	handler.ServeHTTP(revoked, revoke)
	if revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke credential response %d: %s", revoked.Code, revoked.Body.String())
	}
	if _, err := credentials.Resolve(context.Background(), metadata.ID); !errors.Is(err, credentialbroker.ErrCredentialExpired) {
		t.Fatalf("revoked credential remains resolvable: %v", err)
	}
}

func TestRuntimeGatewayProjectsManagedProviderCredentialWithoutReturningSecret(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	credentials := openGatewayCredentials(t)
	type projection struct {
		method, authorization, secret string
	}
	projected := make(chan projection, 2)
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/provider-credentials/deepseek-official" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		body, _ := io.ReadAll(request.Body)
		projected <- projection{method: request.Method, authorization: request.Header.Get("Authorization"), secret: string(body)}
		clearBytes(body)
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	handler := newRuntimeGatewayHandler(catalog, credentials, gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "runtime-token")

	put := httptest.NewRequest(http.MethodPut, "/v1/provider-credentials/harness", strings.NewReader("private-provider-key"))
	put.Header.Set("Authorization", "Bearer runtime-token")
	putResponse := httptest.NewRecorder()
	handler.ServeHTTP(putResponse, put)
	if putResponse.Code != http.StatusOK || strings.Contains(putResponse.Body.String(), "private-provider-key") {
		t.Fatalf("Provider credential response %d: %s", putResponse.Code, putResponse.Body.String())
	}
	first := <-projected
	if first.method != http.MethodPut || first.authorization != "Bearer runtime-token" || first.secret != "private-provider-key" {
		t.Fatalf("Provider projection = %#v", first)
	}
	secret, err := credentials.Resolve(context.Background(), managedHarnessProviderCredentialID)
	if err != nil || string(secret) != "private-provider-key" {
		t.Fatalf("protected Provider credential = %q, %v", secret, err)
	}
	clearBytes(secret)

	revoke := httptest.NewRequest(http.MethodDelete, "/v1/provider-credentials/harness", nil)
	revoke.Header.Set("Authorization", "Bearer runtime-token")
	revokeResponse := httptest.NewRecorder()
	handler.ServeHTTP(revokeResponse, revoke)
	if revokeResponse.Code != http.StatusNoContent {
		t.Fatalf("Provider revoke response %d: %s", revokeResponse.Code, revokeResponse.Body.String())
	}
	second := <-projected
	if second.method != http.MethodDelete || second.authorization != "Bearer runtime-token" || second.secret != "" {
		t.Fatalf("Provider revoke projection = %#v", second)
	}
	if _, err := credentials.Resolve(context.Background(), managedHarnessProviderCredentialID); !errors.Is(err, credentialbroker.ErrCredentialExpired) {
		t.Fatalf("revoked Provider credential remains resolvable: %v", err)
	}
}

func TestRuntimeGatewayRunsManagedProviderHealthThroughPrivateHarnessRoute(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/providers/deepseek-official/test" || request.Method != http.MethodPost || request.Header.Get("Authorization") != "Bearer runtime-token" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"healthy","message":"provider_request_succeeded","elapsed_ms":17}`))
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "runtime-token")

	request := httptest.NewRequest(http.MethodPost, "/v1/provider-credentials/harness/test", nil)
	request.Header.Set("Authorization", "Bearer runtime-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"healthy"`) || !strings.Contains(response.Body.String(), `"elapsed_ms":17`) {
		t.Fatalf("Provider health response %d: %s", response.Code, response.Body.String())
	}
}

func TestRuntimeGatewayExposesCredentialFreeMigrationResults(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	skills := openGatewaySkills(t)
	migration, err := skillmigration.Open(filepath.Join(t.TempDir(), "migration.db"), skills, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer migration.Close()
	if err := migration.ReplacePresetResults(context.Background(), []skillmigration.Result{{SourceID: "assistant", TargetID: "legacy-preset:assistant", Kind: "preset", Status: skillmigration.NeedsReview, Reason: "binding_not_ready"}}); err != nil {
		t.Fatal(err)
	}
	_, err = migration.Migrate(context.Background(), skillmigration.Manifest{
		SchemaVersion: 1, SID: "S-1-5-21-1", CapturedAt: time.Now(),
		Skills: []skillmigration.Asset{{OldID: "legacy", Name: "Legacy", Version: "1", LegacySource: "user", Enabled: true, ContentPath: `C:\private\legacy`}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, skills, gatewayTestPublisher{}, migration, nil, target, "token")
	request := httptest.NewRequest(http.MethodGet, "/v1/migrations/skills-mcp", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"sourceId":"legacy"`) || !strings.Contains(response.Body.String(), `"sourceId":"assistant"`) || strings.Contains(response.Body.String(), `C:\private`) {
		t.Fatalf("migration response %d: %s", response.Code, response.Body.String())
	}
}
