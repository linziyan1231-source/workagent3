package nativeauth

import (
	"github.com/pelletier/go-toml/v2"
	"os"
	"path/filepath"
	"testing"
)

func TestConfigurationRefreshPreservesInstalledCapabilities(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	before := "model = 'old'\n[mcp_servers.example]\ncommand = 'node'\nargs = ['server.js']\n[[skills.config]]\npath = 'C:/skills/example'\nenabled = false\n[providers.custom]\nbase_url = 'https://example.com'\n"
	if err := os.WriteFile(path, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	if err := mergeNativeConfiguration(path, "model = 'new'\n[providers.managed]\nbase_url = 'http://127.0.0.1:1234/v1'\n"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := toml.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result["model"] != "new" || result["mcp_servers"] == nil || result["skills"] == nil || result["providers"].(map[string]any)["custom"] == nil {
		t.Fatalf("configuration lost user settings: %v", result)
	}
}

func TestInvalidConfigurationIsPreserved(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	before := []byte("[invalid")
	if err := os.WriteFile(path, before, 0600); err != nil {
		t.Fatal(err)
	}
	if err := mergeNativeConfiguration(path, "model = 'new'\n"); err == nil {
		t.Fatal("expected parse failure")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("invalid config was overwritten")
	}
}
