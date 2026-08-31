package skillmigration

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCaptureLegacyInventoryRedactsCredentialsAndClassifiesBindings(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "aionui-backend.db")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
CREATE TABLE skills (id TEXT,name TEXT,description TEXT,path TEXT,source TEXT,enabled INTEGER,deleted_at INTEGER);
CREATE TABLE assistants (id TEXT,preset_agent_type TEXT,enabled_skills TEXT,custom_skill_names TEXT);
CREATE TABLE mcp_servers (id TEXT,name TEXT,description TEXT,enabled INTEGER,transport_type TEXT,transport_config TEXT,tools TEXT,builtin INTEGER,deleted_at INTEGER);
CREATE TABLE oauth_tokens (server_url TEXT,access_token TEXT);
`); err != nil {
		t.Fatal(err)
	}
	skillPath := filepath.Join(root, "skills", "review")
	if err := os.MkdirAll(skillPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO skills VALUES ('skill-1','Review','Review docs',?,'user',1,NULL)`, skillPath); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO assistants VALUES ('assistant-1','codex','["Review"]','[]')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO mcp_servers VALUES ('mcp-http','Remote','Remote MCP',1,'http','{"url":"https://user:password@example.test/private/path?token=query-secret","headers":{"Authorization":"Bearer header-secret"}}','[{"name":"search"}]',0,NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO mcp_servers VALUES ('mcp-stdio','Local','Local MCP',1,'stdio','{"command":"C:\\\\Tools\\\\server.exe","args":["--token","arg-secret"],"env":{"API_TOKEN":"env-secret"}}','[]',0,NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO oauth_tokens VALUES ('https://example.test/private/path?token=query-secret','oauth-secret')`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	manifest, err := CaptureLegacyInventory(context.Background(), databasePath, "S-1-5-21-1000", time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Skills) != 1 || len(manifest.MCPServers) != 2 || len(manifest.SkillBindings) != 1 || len(manifest.MCPBindings) != 2 {
		t.Fatalf("inventory counts = skills %d MCP %d skill bindings %d MCP bindings %d", len(manifest.Skills), len(manifest.MCPServers), len(manifest.SkillBindings), len(manifest.MCPBindings))
	}
	encoded, err := manifest.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, secret := range []string{"password", "private/path", "query-secret", "header-secret", "arg-secret", "env-secret", "oauth-secret"} {
		if strings.Contains(text, secret) {
			t.Fatalf("credential material %q leaked into inventory: %s", secret, text)
		}
	}
	if !strings.Contains(text, `"url": "https://example.test/"`) || !strings.Contains(text, `"Authorization": "legacy-mcp-mcp-http-header-1"`) {
		t.Fatalf("redacted HTTP projection missing: %s", text)
	}
	if !strings.Contains(text, `"status": "needs_auth"`) || !strings.Contains(text, `"kind": "skill_binding"`) {
		t.Fatalf("recovery states missing: %s", text)
	}
}

func TestCaptureLegacyInventoryAllowsDatabasesWithoutOptionalTables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE placeholder (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	manifest, err := CaptureLegacyInventory(context.Background(), path, "S-1-5-21-1000", time.Now())
	if err != nil || len(manifest.Skills) != 0 || len(manifest.MCPServers) != 0 {
		t.Fatalf("optional-table inventory = %#v, %v", manifest, err)
	}
}

func TestCaptureLegacyInventoryUsesLatestAssistantDefinitions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
CREATE TABLE skills (id TEXT,name TEXT,description TEXT,path TEXT,source TEXT,enabled INTEGER,deleted_at INTEGER);
CREATE TABLE assistant_definitions (assistant_id TEXT,name TEXT,description TEXT,avatar_type TEXT,avatar_value TEXT,agent_id TEXT,rule_resource_type TEXT,rule_resource_ref TEXT,rule_inline_content TEXT,default_model_mode TEXT,default_model_value TEXT,default_permission_mode TEXT,default_permission_value TEXT,default_skill_ids TEXT,custom_skill_names TEXT,default_mcps_mode TEXT,default_mcp_ids TEXT,deleted_at INTEGER);
CREATE TABLE mcp_servers (id TEXT,name TEXT,description TEXT,enabled INTEGER,transport_type TEXT,transport_config TEXT,tools TEXT,builtin INTEGER,deleted_at INTEGER);
INSERT INTO skills VALUES ('skill-id','Skill name','', 'C:/legacy/skill','user',1,NULL);
INSERT INTO assistant_definitions VALUES ('assistant','Latest assistant','Migrated','url','https://user:password@example.test/avatar.png?token=secret#fragment','codex','inline',NULL,'Keep it concise','fixed','codex-native','fixed','plan','["skill-id"]','[]','fixed','["fixed-mcp"]',NULL);
INSERT INTO mcp_servers VALUES ('fixed-mcp','Fixed','',0,'http','{"url":"https://example.test/path"}','[]',0,NULL);
INSERT INTO mcp_servers VALUES ('unbound-mcp','Unbound','',1,'http','{"url":"https://example.test/path"}','[]',0,NULL);
`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	manifest, err := CaptureLegacyInventory(context.Background(), path, "S-1-5-21-1000", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.SkillBindings) != 1 || manifest.SkillBindings[0].SkillID != "skill-id" {
		t.Fatalf("latest skill bindings = %#v", manifest.SkillBindings)
	}
	if len(manifest.MCPBindings) != 1 || manifest.MCPBindings[0].ServerID != "fixed-mcp" {
		t.Fatalf("latest MCP bindings = %#v", manifest.MCPBindings)
	}
	if len(manifest.Presets) != 1 || manifest.Presets[0].Name != "Latest assistant" || manifest.Presets[0].SystemPrompt != "Keep it concise" || manifest.Presets[0].ApprovalPolicy != "always_ask" || len(manifest.Presets[0].SkillIDs) != 1 || manifest.Presets[0].SkillIDs[0] != "skill-id" || len(manifest.Presets[0].MCPServerIDs) != 1 || manifest.Presets[0].MCPServerIDs[0] != "fixed-mcp" {
		t.Fatalf("latest preset = %#v", manifest.Presets)
	}
	if manifest.Presets[0].Avatar == nil || *manifest.Presets[0].Avatar != "https://example.test/avatar.png" {
		t.Fatalf("sanitized avatar = %#v", manifest.Presets[0].Avatar)
	}
}

func TestCaptureLegacyInventoryResolvesOfficialBuiltinAssistantResources(t *testing.T) {
	root := t.TempDir()
	resources := filepath.Join(root, "puxin-builtin-assistants")
	if err := os.MkdirAll(filepath.Join(resources, "rules"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(resources, "avatars"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resources, "rules", "official.zh-CN.md"), []byte("正式规则"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resources, "avatars", "official.jpg"), []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}
	databasePath := filepath.Join(root, "legacy.db")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
CREATE TABLE skills (id TEXT,name TEXT,description TEXT,path TEXT,source TEXT,enabled INTEGER,deleted_at INTEGER);
CREATE TABLE assistant_definitions (assistant_id TEXT,name TEXT,description TEXT,avatar_type TEXT,avatar_value TEXT,agent_id TEXT,rule_resource_type TEXT,rule_resource_ref TEXT,rule_inline_content TEXT,default_model_mode TEXT,default_model_value TEXT,default_permission_mode TEXT,default_permission_value TEXT,default_skill_ids TEXT,custom_skill_names TEXT,default_mcps_mode TEXT,default_mcp_ids TEXT,deleted_at INTEGER);
INSERT INTO assistant_definitions VALUES ('official','Official','', 'builtin_asset','avatars/official.jpg','aionrs','builtin_asset','official',NULL,'auto',NULL,'auto',NULL,'[]','[]','auto','[]',NULL);
`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	manifest, err := CaptureLegacyInventoryWithAssistantResources(context.Background(), databasePath, "S-1-5-21-1000", time.Now(), AssistantResourceOptions{Root: resources, Locale: "zh-CN", PublicBaseURL: "/assets/puxin-builtin-assistants"})
	if err != nil {
		t.Fatal(err)
	}
	preset := manifest.Presets[0]
	if preset.SystemPrompt != "正式规则" || preset.Avatar == nil || *preset.Avatar != "/assets/puxin-builtin-assistants/avatars/official.jpg" || len(preset.MigrationIssues) != 0 {
		t.Fatalf("resolved builtin preset = %#v", preset)
	}
}
