package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/skillmigration"
	"workagent3/internal/skillruntime"
)

func TestRunMigratesCredentialFreeManifest(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "legacy-skill")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: legacy\ndescription: Legacy skill\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := skillmigration.Manifest{
		SchemaVersion: 1,
		SID:           "S-1-5-21-1",
		CapturedAt:    time.Now(),
		Skills: []skillmigration.Asset{{
			OldID: "legacy", Name: "Legacy", Description: "Legacy skill", Version: "1", LegacySource: "user", Enabled: true, ContentPath: source,
		}},
		MCPServers: []skillmigration.MCPServer{}, SkillBindings: []skillmigration.Binding{}, MCPBindings: []skillmigration.Binding{}, Results: []skillmigration.Result{},
	}
	manifestPath := filepath.Join(root, "manifest.json")
	encoded, _ := json.Marshal(manifest)
	if err := os.WriteFile(manifestPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	runtimeDirectory := filepath.Join(root, "runtime")
	var output bytes.Buffer
	if err := run([]string{"--manifest", manifestPath, "--runtime-dir", runtimeDirectory}, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"status":"ready"`) {
		t.Fatalf("unexpected report: %s", output.String())
	}
	store, err := skillruntime.Open(filepath.Join(runtimeDirectory, "skill-catalog.db"), filepath.Join(runtimeDirectory, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	entry, err := store.Get(t.Context(), "legacy")
	if err != nil || !entry.Enabled {
		t.Fatalf("skill was not migrated: %#v, %v", entry, err)
	}
}

func TestRunRejectsCredentialPlaintext(t *testing.T) {
	root := t.TempDir()
	manifestPath := filepath.Join(root, "manifest.json")
	body := `{"schemaVersion":1,"sid":"S-1-5-21-1","capturedAt":"2026-08-31T00:00:00Z","skills":[],"mcpServers":[{"id":"mcp","name":"MCP","source":"user","enabled":true,"transport":{"kind":"http","url":"https://example.com","headerCredentialIds":{},"headers":{"Authorization":"secret"}},"toolPolicy":"all","allowedTools":[],"oauthState":"none"}],"skillBindings":[],"mcpBindings":[],"results":[]}`
	if err := os.WriteFile(manifestPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	err := run([]string{"--manifest", manifestPath, "--runtime-dir", filepath.Join(root, "runtime")}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("plaintext field was accepted: %v", err)
	}
}
