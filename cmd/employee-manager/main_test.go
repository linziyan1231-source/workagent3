package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/mcpruntime"
)

func TestLoadManagerConfigRejectsRelativeOrUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manager.json")
	if err := os.WriteFile(path, []byte(`{"databasePath":"relative.db","dataRootBase":"relative","userHostExecutable":"relative","harnessCommand":"relative","profile":"workagent","portalUrl":"http://127.0.0.1:8080","limits":{},"unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadManagerConfig(path); err == nil {
		t.Fatal("unsafe manager configuration was accepted")
	}
}

func TestBytesTrimLineEndingPreservesPasswordContent(t *testing.T) {
	value := bytesTrimLineEnding([]byte("correct horse battery staple\r\n"))
	if string(value) != "correct horse battery staple" {
		t.Fatalf("unexpected password %q", value)
	}
}

func TestManagerConfigKeepsLifecycleActionsOnThePrivilegedBoundary(t *testing.T) {
	// The Employee Manager executable owns lifecycle dispatch. This regression
	// test documents that its configuration remains sufficient for both initial
	// provisioning and later start/stop operations without Portal internals.
	root := t.TempDir()
	path := filepath.Join(root, "manager.json")
	payload := managerConfig{
		DatabasePath: filepath.Join(root, "portal.db"), DataRootBase: filepath.Join(root, "users"),
		UserHostExecutable: filepath.Join(root, "userhost"), HarnessCommand: filepath.Join(root, "node"),
		HarnessEntrypoint: "dist/index.js", Profile: "workagent",
		HarnessProfileSource: filepath.Join(root, "profile"), PortalURL: "https://portal.test",
		ManagedSkillsRoot: filepath.Join(root, "managed-skills"),
		ManagedMCPServers: []mcpruntime.Server{{
			ID: "managed", Name: "Managed", Source: "managed", Enabled: false,
			Transport:  mcpruntime.Transport{Kind: "stdio", Command: filepath.Join(root, "managed.exe")},
			ToolPolicy: "none", OAuthState: "none", Health: "unavailable",
		}},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := loadManagerConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.PortalURL != "https://portal.test" || config.DataRootBase != filepath.Join(root, "users") || config.ManagedSkillsRoot != filepath.Join(root, "managed-skills") {
		t.Fatalf("unexpected lifecycle configuration: %+v", config)
	}
	if len(config.ManagedMCPServers) != 1 || config.ManagedMCPServers[0].ID != "managed" {
		t.Fatalf("managed MCP release was not loaded: %+v", config.ManagedMCPServers)
	}
}

func writeManagedToolsRoot(t *testing.T, binary []byte, record string) string {
	t.Helper()
	root := t.TempDir()
	if binary != nil {
		if err := os.WriteFile(filepath.Join(root, "officecli.exe"), binary, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if record != "" {
		if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte(record), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func managedToolsRecord(t *testing.T, binary []byte) string {
	t.Helper()
	digest := sha256.Sum256(binary)
	return fmt.Sprintf(`{"schemaVersion":1,"name":"OfficeCLI","version":"1.0.146","license":"Apache-2.0","sha256":"%s"}`, hex.EncodeToString(digest[:]))
}

func TestVerifyManagedToolsAcceptsPinnedBinary(t *testing.T) {
	binary := []byte("officecli-test-binary")
	root := writeManagedToolsRoot(t, binary, managedToolsRecord(t, binary))
	if err := verifyManagedTools(root); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyManagedToolsRejectsHashMismatch(t *testing.T) {
	root := writeManagedToolsRoot(t, []byte("tampered-binary"), managedToolsRecord(t, []byte("officecli-test-binary")))
	err := verifyManagedTools(root)
	if err == nil || !strings.Contains(err.Error(), "integrity verification") {
		t.Fatalf("tampered binary was not rejected: %v", err)
	}
}

func TestVerifyManagedToolsRejectsMissingBinary(t *testing.T) {
	root := writeManagedToolsRoot(t, nil, managedToolsRecord(t, []byte("officecli-test-binary")))
	if err := verifyManagedTools(root); err == nil {
		t.Fatal("missing officecli.exe was not rejected")
	}
}

func TestVerifyManagedToolsRejectsManifestWithoutLicense(t *testing.T) {
	binary := []byte("officecli-test-binary")
	digest := sha256.Sum256(binary)
	record := fmt.Sprintf(`{"schemaVersion":1,"name":"OfficeCLI","version":"1.0.146","sha256":"%s"}`, hex.EncodeToString(digest[:]))
	root := writeManagedToolsRoot(t, binary, record)
	if err := verifyManagedTools(root); err == nil {
		t.Fatal("manifest without a license record was not rejected")
	}
}

func TestVerifyManagedToolsRejectsMissingManifest(t *testing.T) {
	root := writeManagedToolsRoot(t, []byte("officecli-test-binary"), "")
	if err := verifyManagedTools(root); err == nil {
		t.Fatal("missing manifest was not rejected")
	}
}

func TestVerifyManagedToolsMatchesCheckedInOfficeCLIRecord(t *testing.T) {
	root := filepath.Join("..", "..", "release", "managed-tools", "officecli")
	if _, err := os.Stat(filepath.Join(root, "officecli.exe")); err != nil {
		t.Skip("checked-in OfficeCLI binary is not present")
	}
	if err := verifyManagedTools(root); err != nil {
		t.Fatalf("checked-in managed OfficeCLI install failed verification: %v", err)
	}
}
