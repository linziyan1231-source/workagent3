package userhost

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"workagent3/internal/mcpruntime"
)

func TestProfessionalDatabaseConfigurationAcceptsOnlyExactLoopbackServiceURLs(t *testing.T) {
	for _, value := range []string{"", "http://127.0.0.1:18306/professional-database/mcp", "http://[::1]:18306/professional-database/mcp"} {
		if err := ValidateProfessionalDatabaseURL(value); err != nil {
			t.Errorf("valid URL rejected: %s %v", value, err)
		}
	}
	for _, value := range []string{
		"https://127.0.0.1:18306/professional-database/mcp", "http://example.com:18306/professional-database/mcp",
		"http://localhost:18306/professional-database/mcp", "http://192.168.1.1:18306/professional-database/mcp",
		"http://127.0.0.1/professional-database/mcp", "http://127.0.0.1:0/professional-database/mcp",
		"http://127.0.0.1:65536/professional-database/mcp", "http://127.0.0.1:18306/mcp",
		"http://127.0.0.1:18306/professional-database/mcp/", "http://127.0.0.1:18306/professional-database/%6dcp",
		"http://127.0.0.1:18306/professional-database/mcp?", "http://127.0.0.1:18306/professional-database/mcp?q=1",
		"http://127.0.0.1:18306/professional-database/mcp#token", "http://secret@127.0.0.1:18306/professional-database/mcp",
		"http://127.0.0.1:18306/professional-database/mcp#",
	} {
		if err := ValidateProfessionalDatabaseURL(value); err == nil {
			t.Errorf("invalid trusted URL accepted: %s", value)
		}
	}
}

func TestProfessionalDatabaseFileConfigAndSupervisorValidateTrustedURL(t *testing.T) {
	root := t.TempDir()
	base := FileConfig{SID: "S-1-5-21-1000", DataRoot: root, HarnessCommand: filepath.Join(root, "harness.exe"), Profile: "workagent", PortalURL: "http://127.0.0.1:8080", RegistrationCredentialFile: filepath.Join(root, "registration.token")}
	for _, value := range []string{"", "http://127.0.0.1:18306/professional-database/mcp", "http://192.168.1.1:18306/professional-database/mcp"} {
		base.ProfessionalDatabaseURL = value
		data, _ := json.Marshal(base)
		file := filepath.Join(root, "userhost.json")
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadFileConfig(file)
		valid := !strings.Contains(value, "192.168")
		if valid && (err != nil || loaded.ProfessionalDatabaseURL != value) {
			t.Fatalf("URL not loaded: %s %v", value, err)
		}
		if !valid && err == nil {
			t.Fatal("file configuration trusted an external service")
		}
		config := Config{SID: base.SID, DataRoot: root, Command: base.HarnessCommand, Profile: base.Profile, PlatformURL: base.PortalURL, PlatformCredential: "token", ProfessionalDatabaseURL: value}
		_, err = New(config)
		if (err == nil) != valid {
			t.Fatalf("supervisor URL validation %s: %v", value, err)
		}
	}
}

func TestProfessionalDatabaseConnectionTestOnlyAllowsExactConfiguredURL(t *testing.T) {
	var accepted, otherCalls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accepted.Add(1)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"professional-database","version":"1"}}}`))
	}))
	defer upstream.Close()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { otherCalls.Add(1) }))
	defer other.Close()
	trusted := upstream.URL + "/professional-database/mcp"
	for _, test := range []struct {
		name, endpoint, configured string
		success                    bool
	}{
		{"legacy-empty", trusted, "", false},
		{"exact", trusted, trusted, true},
		{"wrong-path", upstream.URL + "/v1/users", trusted, false},
		{"wrong-port", other.URL + "/professional-database/mcp", trusted, false},
		{"query", trusted + "?x=1", trusted, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := mcpruntime.Server{Source: "user", Enabled: true, OAuthState: "none", Transport: mcpruntime.Transport{Kind: "http", URL: test.endpoint}}
			err := initializeMCP(t.Context(), server, nil, test.configured, nil)
			if (err == nil) != test.success {
				t.Fatalf("expected success=%v error=%v", test.success, err)
			}
		})
	}
	if accepted.Load() != 1 || otherCalls.Load() != 0 {
		t.Fatalf("connection allowance leaked: accepted=%d other=%d", accepted.Load(), otherCalls.Load())
	}
}

func TestProfessionalDatabaseTrustedConnectionNeverFollowsRedirects(t *testing.T) {
	var targetCalls atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1) }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/v1/users", http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	trusted := upstream.URL + "/professional-database/mcp"
	server := mcpruntime.Server{Source: "user", Enabled: true, OAuthState: "none", Transport: mcpruntime.Transport{Kind: "http", URL: trusted}}
	if err := initializeHTTPMCP(t.Context(), server, nil, trusted); err == nil {
		t.Fatal("redirect reported success")
	}
	if targetCalls.Load() != 0 {
		t.Fatal("trusted MCP request followed a redirect")
	}
}

func TestProfessionalDatabaseTrustedURLReachesGatewayConnectionHandler(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"capabilities":{},"serverInfo":{"name":"professional-database","version":"1"}}}`))
	}))
	defer upstream.Close()
	trusted := upstream.URL + "/professional-database/mcp"
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	_, err = catalog.Create(t.Context(), mcpruntime.Server{ID: "professional", Name: "Professional database", Source: "user", Enabled: true, OAuthState: "none", Health: "unknown", ToolPolicy: "all", AllowedTools: []string{}, Transport: mcpruntime.Transport{Kind: "http", URL: trusted}})
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandlerWithControl(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "runtime-token", nil, nil, nil, "", nil, nil, nil, trusted)
	request := httptest.NewRequest("POST", "/v1/mcp-servers/professional/test", nil)
	request.Header.Set("Authorization", "Bearer runtime-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"success":true`) {
		t.Fatalf("trusted configuration not propagated: %d %s", response.Code, response.Body.String())
	}
}
