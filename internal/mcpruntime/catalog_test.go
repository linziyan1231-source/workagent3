package mcpruntime

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestCatalogPersistsCredentialReferencesWithoutSecretFields(t *testing.T) {
	catalog, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	server, err := catalog.Create(t.Context(), Server{
		ID: "mcp-1", Name: "local-tool", Source: "managed", Enabled: true,
		Transport:  Transport{Kind: "stdio", Command: filepath.Join(t.TempDir(), "server.exe"), Args: []string{"serve"}, EnvironmentCredentialIDs: map[string]string{"API_TOKEN": "credential-1"}},
		ToolPolicy: "allowlist", AllowedTools: []string{"inspect"}, OAuthState: "none", Health: "healthy",
	})
	if err != nil {
		t.Fatal(err)
	}
	if server.Transport.EnvironmentCredentialIDs["API_TOKEN"] != "credential-1" {
		t.Fatalf("credential reference lost: %#v", server.Transport)
	}
	if len(server.AllowedTools) != 1 {
		t.Fatalf("tool allowlist lost: %#v", server.AllowedTools)
	}
}

func TestCatalogRejectsUnsafeRemoteAndRelativeStdioTransports(t *testing.T) {
	catalog, _ := Open(":memory:")
	defer catalog.Close()
	base := Server{ID: "unsafe", Name: "unsafe", Source: "user", ToolPolicy: "all", OAuthState: "none", Health: "unknown"}
	base.Transport = Transport{Kind: "http", URL: "http://example.com/mcp"}
	if _, err := catalog.Create(t.Context(), base); err == nil {
		t.Fatal("insecure remote MCP endpoint accepted")
	}
	base.Transport = Transport{Kind: "stdio", Command: "server.exe"}
	if _, err := catalog.Create(t.Context(), base); err == nil {
		t.Fatal("relative stdio MCP command accepted")
	}
}

func TestCatalogRejectsUnsafeCredentialNames(t *testing.T) {
	catalog, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	for _, transport := range []Transport{
		{Kind: "stdio", Command: filepath.Join(t.TempDir(), "server.exe"), EnvironmentCredentialIDs: map[string]string{"BAD=NAME": "credential"}},
		{Kind: "http", URL: "https://example.com/mcp", HeaderCredentialIDs: map[string]string{"Bad\r\nHeader": "credential"}},
	} {
		_, err := catalog.Create(t.Context(), Server{
			ID: "unsafe", Name: "Unsafe", Source: "user", Enabled: true, Transport: transport,
			ToolPolicy: "all", OAuthState: "none", Health: "unknown",
		})
		if err == nil {
			t.Fatalf("unsafe credential name was accepted: %#v", transport)
		}
	}
}

func TestProjectionFailsExplicitlyForUnsupportedOrUnavailableServer(t *testing.T) {
	server := Server{ID: "mcp-sse", Enabled: true, Transport: Transport{Kind: "sse"}, OAuthState: "ready", Health: "healthy"}
	if _, err := Project([]Server{server}, EngineCapabilities{Engine: "codex", Stdio: true, HTTP: true}); !errors.Is(err, ErrUnsupportedTransport) {
		t.Fatalf("unsupported projection returned %v", err)
	}
	server.OAuthState = "needs_auth"
	if _, err := Project([]Server{server}, EngineCapabilities{Engine: "kimi", Stdio: true, HTTP: true, SSE: true}); !errors.Is(err, ErrServerUnavailable) {
		t.Fatalf("needs-auth projection returned %v", err)
	}
}

func TestCatalogAcceptsAllTransportsAndProjectsTheEngineSupportMatrix(t *testing.T) {
	servers := map[string]Server{
		"stdio": {
			ID: "stdio", Name: "Stdio", Source: "managed", Enabled: true,
			Transport:  Transport{Kind: "stdio", Command: filepath.Join(t.TempDir(), "server.exe")},
			ToolPolicy: "all", OAuthState: "none", Health: "healthy",
		},
		"http": {
			ID: "http", Name: "HTTP", Source: "user", Enabled: true,
			Transport:  Transport{Kind: "http", URL: "https://example.com/mcp"},
			ToolPolicy: "all", OAuthState: "none", Health: "healthy",
		},
		"sse": {
			ID: "sse", Name: "SSE", Source: "user", Enabled: true,
			Transport:  Transport{Kind: "sse", URL: "https://example.com/events"},
			ToolPolicy: "all", OAuthState: "none", Health: "healthy",
		},
	}
	catalog, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	for kind, server := range servers {
		if _, err := catalog.Create(t.Context(), server); err != nil {
			t.Fatalf("catalog rejected %s transport: %v", kind, err)
		}
	}

	engines := map[string]EngineCapabilities{
		"harness": {Engine: "harness", Stdio: true, HTTP: true},
		"codex":   {Engine: "codex", Stdio: true, HTTP: true},
		"kimi":    {Engine: "kimi", Stdio: true, HTTP: true, SSE: true},
	}
	for engine, capabilities := range engines {
		for kind, server := range servers {
			_, err := Project([]Server{server}, capabilities)
			if kind == "sse" && engine != "kimi" {
				if !errors.Is(err, ErrUnsupportedTransport) {
					t.Fatalf("%s %s projection returned %v", engine, kind, err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("%s rejected supported %s transport: %v", engine, kind, err)
			}
		}
	}
}
