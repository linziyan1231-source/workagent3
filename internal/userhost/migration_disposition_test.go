package userhost

import (
	"context"
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
)

func migrationDispositionFixture(t *testing.T) (*mcpruntime.Catalog, *credentialbroker.Store, *skillmigration.Store) {
	t.Helper()
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { catalog.Close() })
	credentials := openGatewayCredentials(t)
	skills := openGatewaySkills(t)
	migration, err := skillmigration.Open(filepath.Join(t.TempDir(), "migration.db"), skills, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { migration.Close() })
	return catalog, credentials, migration
}

func serveMigrationDisposition(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestRuntimeGatewayMigrationResolve(t *testing.T) {
	catalog, credentials, migration := migrationDispositionFixture(t)
	_, err := migration.Migrate(context.Background(), skillmigration.Manifest{
		SchemaVersion: 1, SID: "S-1-5-21-1", CapturedAt: time.Now(),
		Skills: []skillmigration.Asset{{OldID: "legacy", Name: "Legacy", Version: "1", LegacySource: "user", Enabled: true, ContentPath: `C:\private\legacy`}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, credentials, gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, migration, nil, target, "token")

	response := serveMigrationDisposition(handler, http.MethodPost, "/v1/migrations/resolve", `{"kind":"skill","sourceId":"legacy"}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"ready"`) || !strings.Contains(response.Body.String(), `"manually_resolved"`) {
		t.Fatalf("resolve response %d: %s", response.Code, response.Body.String())
	}
	settled := serveMigrationDisposition(handler, http.MethodPost, "/v1/migrations/resolve", `{"kind":"skill","sourceId":"legacy"}`)
	if settled.Code != http.StatusConflict || !strings.Contains(settled.Body.String(), "migration_item_settled") {
		t.Fatalf("settled resolve %d: %s", settled.Code, settled.Body.String())
	}
	missing := serveMigrationDisposition(handler, http.MethodPost, "/v1/migrations/resolve", `{"kind":"skill","sourceId":"missing"}`)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing resolve %d: %s", missing.Code, missing.Body.String())
	}
	invalid := serveMigrationDisposition(handler, http.MethodPost, "/v1/migrations/resolve", `{"kind":"skill"}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid resolve %d: %s", invalid.Code, invalid.Body.String())
	}
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodPost, "/v1/migrations/resolve", strings.NewReader(`{"kind":"skill","sourceId":"legacy"}`)))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated resolve %d", unauthenticated.Code)
	}
}

func TestRuntimeGatewayMigrationRetryMCP(t *testing.T) {
	catalog, credentials, migration := migrationDispositionFixture(t)
	asset := skillmigration.MCPServer{
		ID: "legacy-mcp", Name: "Legacy MCP", Source: "user", Enabled: true, ToolPolicy: "all",
		Transport: skillmigration.MCPTransport{Kind: "http", URL: "https://mcp.example.com/", HeaderCredentialIDs: map[string]string{"Authorization": "cred-1"}},
	}
	results, err := migration.MigrateMCP(context.Background(), []skillmigration.MCPServer{asset}, catalog, credentialStates{"cred-1": false}, nil)
	if err != nil || len(results) != 1 || results[0].Status != skillmigration.NeedsAuth {
		t.Fatalf("unexpected MCP migration: %#v, %v", results, err)
	}
	if _, err := credentials.Put(context.Background(), credentialbroker.Input{ID: "cred-1", Kind: credentialbroker.KindMCPHeader, Label: "Legacy", Secret: []byte("s3cret"), State: credentialbroker.StateReady}); err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, credentials, gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, migration, nil, target, "token")

	response := serveMigrationDisposition(handler, http.MethodPost, "/v1/migrations/retry", `{"kind":"mcp_server","sourceId":"legacy-mcp"}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"needs_review"`) || !strings.Contains(response.Body.String(), "connection_test_required") {
		t.Fatalf("retry response %d: %s", response.Code, response.Body.String())
	}
	unknownKind := serveMigrationDisposition(handler, http.MethodPost, "/v1/migrations/retry", `{"kind":"oauth","sourceId":"legacy-mcp"}`)
	if unknownKind.Code != http.StatusBadRequest {
		t.Fatalf("invalid kind retry %d: %s", unknownKind.Code, unknownKind.Body.String())
	}
	preset := serveMigrationDisposition(handler, http.MethodPost, "/v1/migrations/retry", `{"kind":"preset","sourceId":"assistant"}`)
	if preset.Code != http.StatusServiceUnavailable || !strings.Contains(preset.Body.String(), "preset_projection_unavailable") {
		t.Fatalf("preset retry without publisher %d: %s", preset.Code, preset.Body.String())
	}
}

type credentialStates map[string]bool

func (states credentialStates) CredentialReady(_ context.Context, id string) bool { return states[id] }
