package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/skillmigration"
	"workagent3/internal/skillruntime"
)

func TestRunCapturesCredentialFreeLegacyInventoryWithoutOverwrite(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "legacy.db")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE skills (id TEXT,name TEXT,description TEXT,path TEXT,source TEXT,enabled INTEGER,deleted_at INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	outputPath := filepath.Join(root, "inventory.json")
	var output bytes.Buffer
	arguments := []string{"--action", "inventory", "--legacy-db", databasePath, "--sid", "S-1-5-21-1", "--output", outputPath}
	if err := run(arguments, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"skills":0`) {
		t.Fatalf("unexpected inventory summary: %s", output.String())
	}
	payload, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest skillmigration.Manifest
	if err := json.Unmarshal(payload, &manifest); err != nil || manifest.SID != "S-1-5-21-1" {
		t.Fatalf("inventory = %#v, %v", manifest, err)
	}
	if err := run(arguments, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "file exists") {
		t.Fatalf("inventory output was overwritten: %v", err)
	}
}

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

func TestRunMigratesMCPBeforeDependentSkill(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "dependent-skill")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: dependent\ndescription: Dependent skill\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := skillmigration.Manifest{
		SchemaVersion: 1, SID: "S-1-5-21-1", CapturedAt: time.Now(),
		MCPServers: []skillmigration.MCPServer{{
			ID: "old-mcp", Name: "Remote", Description: "Remote MCP", Source: "user", Enabled: true,
			Transport:  skillmigration.MCPTransport{Kind: "http", URL: "https://example.com/mcp", HeaderCredentialIDs: map[string]string{}},
			ToolPolicy: "all", AllowedTools: []string{}, OAuthState: "none",
		}},
		Skills: []skillmigration.Asset{{
			OldID: "dependent", Name: "Dependent", Description: "Dependent skill", Version: "1", LegacySource: "user", Enabled: true,
			ContentPath: source, RequiredMCPServerIDs: []string{"old-mcp"},
		}},
		SkillBindings: []skillmigration.Binding{}, MCPBindings: []skillmigration.Binding{}, Results: []skillmigration.Result{},
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
	if !strings.Contains(output.String(), `"kind":"mcp_server","status":"needs_review"`) || !strings.Contains(output.String(), `"kind":"skill","status":"needs_review"`) {
		t.Fatalf("unexpected combined migration report: %s", output.String())
	}
	store, err := skillruntime.Open(filepath.Join(runtimeDirectory, "skill-catalog.db"), filepath.Join(runtimeDirectory, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	entry, err := store.Get(t.Context(), "dependent")
	if err != nil || entry.Enabled || len(entry.RequiredMCPServerIDs) != 1 || entry.RequiredMCPServerIDs[0] != "old-mcp" {
		t.Fatalf("dependent skill state is wrong: %#v, %v", entry, err)
	}
}

func TestRunUsesManagedReleaseForLegacyBuiltinState(t *testing.T) {
	root := t.TempDir()
	manifest := skillmigration.Manifest{
		SchemaVersion: 1, SID: "S-1-5-21-1", CapturedAt: time.Now(),
		Skills: []skillmigration.Asset{{
			OldID: "wiki-query", Name: "wiki-query", Description: "legacy copy", Version: "0.0.1", LegacySource: "builtin", Enabled: false, ContentPath: filepath.Join(root, "obsolete"),
		}},
		MCPServers: []skillmigration.MCPServer{}, SkillBindings: []skillmigration.Binding{}, MCPBindings: []skillmigration.Binding{}, Results: []skillmigration.Result{},
	}
	manifestPath := filepath.Join(root, "manifest.json")
	encoded, _ := json.Marshal(manifest)
	if err := os.WriteFile(manifestPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	releaseRoot, _ := filepath.Abs(filepath.Join("..", "..", "release", "managed-skills"))
	runtimeDirectory := filepath.Join(root, "runtime")
	var output bytes.Buffer
	if err := run([]string{"--manifest", manifestPath, "--runtime-dir", runtimeDirectory, "--release-skills-root", releaseRoot}, &output); err != nil {
		t.Fatal(err)
	}
	store, err := skillruntime.Open(filepath.Join(runtimeDirectory, "skill-catalog.db"), filepath.Join(runtimeDirectory, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	entry, err := store.Get(t.Context(), "wiki-query")
	if err != nil || entry.Source != "managed" || entry.Version != "0.1.0" || entry.Enabled {
		t.Fatalf("managed builtin migration = %#v, %v; report %s", entry, err, output.String())
	}
	if _, err := os.Stat(filepath.Join(store.DirectoryFor(entry), "..", "..", "scripts", "wiki_tool.py")); err != nil {
		t.Fatalf("managed shared script was not installed: %v", err)
	}
}
