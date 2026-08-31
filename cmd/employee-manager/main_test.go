package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
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
	if config.PortalURL != "https://portal.test" || config.DataRootBase != filepath.Join(root, "users") {
		t.Fatalf("unexpected lifecycle configuration: %+v", config)
	}
}
