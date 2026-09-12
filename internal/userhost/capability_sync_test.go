package userhost

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeGlobalFixture(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestGlobalSyncLifecycleAndProjectBoundary(t *testing.T) {
	root := t.TempDir()
	imports := testImporter(t)
	writeGlobalFixture(t, filepath.Join(root, "runtime", "placeholder"), "")
	config := filepath.Join(root, "native", "codex", "config.toml")
	writeGlobalFixture(t, config, "[mcp_servers.docs]\nurl='https://example.test/mcp'\n[mcp_servers.docs.http_headers]\nAuthorization='private-sync-secret'\n")
	document := "---\nname: global-example\ndescription: A global skill\n---\nRead resources/example.txt.\n"
	source := filepath.Join(root, "native", "codex", "skills", "example")
	writeGlobalFixture(t, filepath.Join(source, "SKILL.md"), document)
	writeGlobalFixture(t, filepath.Join(source, "resources", "example.txt"), "shared resource")
	project := filepath.Join(root, "workspace", "project")
	writeGlobalFixture(t, filepath.Join(project, ".agents", "skills", "project-only", "SKILL.md"), "---\nname: project-only\ndescription: Project only\n---\n")
	writeGlobalFixture(t, filepath.Join(project, ".codex", "config.toml"), "[mcp_servers.project]\nurl='https://project.test/mcp'\n")
	service, err := newCapabilitySync(root, imports)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.run(t.Context()); err != nil {
		t.Fatal(err)
	}
	skills, err := imports.skills.List(t.Context())
	if err != nil || len(skills) != 1 {
		t.Fatalf("skills=%v err=%v", skills, err)
	}
	servers, err := imports.mcp.List(t.Context())
	if err != nil || len(servers) != 1 {
		t.Fatalf("MCP=%v err=%v", servers, err)
	}
	skillID, serverID := skills[0].ID, servers[0].ID
	shared := filepath.Join(root, ".agents", "skills", "wa3-"+skillID, "resources", "example.txt")
	if data, err := os.ReadFile(shared); err != nil || string(data) != "shared resource" {
		t.Fatalf("shared resource inaccessible: %v", err)
	}
	if _, err := imports.skills.SetEnabled(t.Context(), skillID, false); err != nil {
		t.Fatal(err)
	}
	server := servers[0]
	server.Enabled = false
	if _, err := imports.mcp.Replace(t.Context(), server); err != nil {
		t.Fatal(err)
	}
	if err := service.run(t.Context()); err != nil {
		t.Fatal(err)
	}
	skill, _ := imports.skills.Get(t.Context(), skillID)
	server, _ = imports.mcp.Get(t.Context(), serverID)
	if skill.Enabled || server.Enabled {
		t.Fatal("rescan reenabled capabilities")
	}
	if _, err := os.Stat(shared); !os.IsNotExist(err) {
		t.Fatal("disabled skill remains shared")
	}
	if err := imports.skills.Remove(t.Context(), skillID); err != nil {
		t.Fatal(err)
	}
	paths, err := imports.skills.NativeSkillPaths(t.Context())
	if err != nil || len(paths) != 1 || paths[0] != filepath.Join(source, "SKILL.md") {
		t.Fatalf("native deletion suppression lost: %v %v", paths, err)
	}
	if err := imports.mcp.Delete(t.Context(), serverID); err != nil {
		t.Fatal(err)
	}
	service, err = newCapabilitySync(root, imports)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.run(t.Context()); err != nil {
		t.Fatal(err)
	}
	skills, _ = imports.skills.List(t.Context())
	servers, _ = imports.mcp.List(t.Context())
	if len(skills) != 0 || len(servers) != 0 {
		t.Fatal("deleted registrations resurrected")
	}
	if _, err := os.Stat(filepath.Join(source, "SKILL.md")); err != nil {
		t.Fatal("source was removed")
	}
	names, err := imports.mcp.NativeNames(t.Context())
	if err != nil || len(names) != 1 || names[0] != "docs" {
		t.Fatal("native suppression did not survive catalog deletion")
	}
	state, err := os.ReadFile(service.path())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(state, []byte("private-sync-secret")) {
		t.Fatal("sync journal leaked credentials")
	}
	other := t.TempDir()
	writeGlobalFixture(t, filepath.Join(other, "runtime", "placeholder"), "")
	isolated, err := newCapabilitySync(other, testImporter(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := isolated.run(t.Context()); err != nil || len(isolated.rows) != 0 {
		t.Fatal("capabilities leaked to another employee")
	}
}

func TestGlobalSyncPreservesSettingsOnSourceConflict(t *testing.T) {
	root := t.TempDir()
	writeGlobalFixture(t, filepath.Join(root, "runtime", "placeholder"), "")
	path := filepath.Join(root, "native", "codex", "config.toml")
	writeGlobalFixture(t, path, "[mcp_servers.docs]\nurl='https://original.test/mcp'\n")
	imports := testImporter(t)
	service, err := newCapabilitySync(root, imports)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.run(t.Context()); err != nil {
		t.Fatal(err)
	}
	servers, _ := imports.mcp.List(t.Context())
	server := servers[0]
	server.Transport.URL = "https://settings.test/mcp"
	time.Sleep(2 * time.Millisecond)
	if _, err := imports.mcp.Replace(t.Context(), server); err != nil {
		t.Fatal(err)
	}
	writeGlobalFixture(t, path, "[mcp_servers.docs]\nurl='https://source-update.test/mcp'\n")
	if err := service.run(t.Context()); err != nil {
		t.Fatal(err)
	}
	current, _ := imports.mcp.Get(t.Context(), server.ID)
	if current.Transport.URL != "https://settings.test/mcp" || service.rows["codex/config:docs"].Status != "conflict" {
		t.Fatal("source silently replaced settings")
	}
}

func TestDiscoveryUsesEnabledPluginActiveVersion(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "native", "codex")
	writeGlobalFixture(t, filepath.Join(home, "config.toml"), "[plugins.'example@local-market']\nenabled=true\n[plugins.'disabled@local-market']\nenabled=false\n")
	for _, version := range []string{"1.9.0", "1.10.0"} {
		path := filepath.Join(home, "plugins", "cache", "local-market", "example", version)
		writeGlobalFixture(t, filepath.Join(path, ".codex-plugin", "plugin.json"), `{"name":"example","skills":"skills"}`)
		writeGlobalFixture(t, filepath.Join(path, "skills", "example", "SKILL.md"), "---\nname: plugin-example\ndescription: Plugin fixture\n---\n")
	}
	items, err := discoverGlobalCapabilities(root)
	if err != nil || len(items) != 1 {
		t.Fatalf("items=%v err=%v", items, err)
	}
	if items[0].Directory != filepath.Join(home, "plugins", "cache", "local-market", "example", "1.10.0", "skills", "example") {
		t.Fatal("wrong active version")
	}
}
