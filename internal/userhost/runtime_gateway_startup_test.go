package userhost

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillmigration"
	"workagent3/internal/skillruntime"
)

// Regression for the post-restart migration-list blind window (B4-F1): the
// runtime gateway must serve the journaled migration results as soon as the
// local stores are open, even while the Harness-facing startup delivery is
// still blocked. Previously the listener (and with it the Portal lease) only
// came up after all delivery round-trips finished, so a slow or cold Harness
// left GET /api/portal/admin/migrations empty for minutes after every
// UserHost restart although skill-migration.db had the rows all along.
func TestRuntimeGatewayServesMigrationJournalDuringStartupDelivery(t *testing.T) {
	sid := "S-1-5-21-1000"
	dataRoot := filepath.Join(t.TempDir(), sid)
	runtimeDirectory := filepath.Join(dataRoot, "runtime")
	dshHome := filepath.Join(dataRoot, "dsh-home")
	for _, directory := range []string{runtimeDirectory, dshHome} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	// Seed the journal exactly as the offline migrator does, then close every
	// store to simulate the state right after a UserHost restart.
	catalog, err := mcpruntime.Open(filepath.Join(runtimeDirectory, "mcp-catalog.db"))
	if err != nil {
		t.Fatal(err)
	}
	skills, err := skillruntime.Open(filepath.Join(runtimeDirectory, "skill-catalog.db"), filepath.Join(runtimeDirectory, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	migration, err := skillmigration.Open(filepath.Join(runtimeDirectory, "skill-migration.db"), skills, nil)
	if err != nil {
		t.Fatal(err)
	}
	asset := skillmigration.MCPServer{
		ID: "legacy-mcp", Name: "Legacy MCP", Source: "user", Enabled: true, ToolPolicy: "all",
		Transport: skillmigration.MCPTransport{Kind: "http", URL: "https://mcp.example.com/", HeaderCredentialIDs: map[string]string{"Authorization": "cred-1"}},
	}
	if results, err := migration.MigrateMCP(context.Background(), []skillmigration.MCPServer{asset}, catalog, credentialStates{"cred-1": false}, nil); err != nil || len(results) != 1 || results[0].Status != skillmigration.NeedsAuth {
		t.Fatalf("unexpected MCP migration seed: %#v, %v", results, err)
	}
	migration.Close()
	skills.Close()
	catalog.Close()

	// The Harness stub blocks the first delivery round-trip until released.
	release := make(chan struct{})
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/internal/mcp-projection" {
			<-release
		}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)

	gateway, err := newRuntimeGateway(runtimeDirectory, dshHome, "", nil, "", dataRoot, sid, "", target, "runtime-token", nil, nil, func() {})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = gateway.server.Serve(listener) }()

	deliverDone := make(chan error, 1)
	go func() { deliverDone <- gateway.deliver(context.Background()) }()

	// The journal endpoint must answer while the startup delivery is blocked.
	deadline := time.Now().Add(5 * time.Second)
	var body string
	for {
		request, _ := http.NewRequest(http.MethodGet, "http://"+listener.Addr().String()+"/v1/migrations/skills-mcp", nil)
		request.Header.Set("Authorization", "Bearer runtime-token")
		response, requestErr := http.DefaultClient.Do(request)
		if requestErr == nil {
			payload, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				body = string(payload)
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("migration journal endpoint did not answer during startup delivery")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(body, `"sourceId":"legacy-mcp"`) || !strings.Contains(body, `"status":"needs_auth"`) {
		t.Fatalf("migration journal not served during startup delivery: %s", body)
	}

	close(release)
	if err := <-deliverDone; err != nil {
		t.Fatalf("startup delivery: %v", err)
	}
}
