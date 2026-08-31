package skillmigration

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type legacyAssistant struct {
	id      string
	engine  string
	skills  []string
	mcpMode string
	mcps    []string
	preset  PresetAsset
}

func CaptureLegacyInventory(ctx context.Context, databasePath, sid string, capturedAt time.Time) (Manifest, error) {
	if !filepath.IsAbs(databasePath) || !validSID(sid) || capturedAt.IsZero() {
		return Manifest{}, errors.New("absolute legacy database, SID, and capture time are required")
	}
	info, err := os.Lstat(databasePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return Manifest{}, errors.New("legacy database must be a regular file")
	}
	database, err := sql.Open("sqlite", readonlySQLiteDSN(databasePath))
	if err != nil {
		return Manifest{}, err
	}
	defer database.Close()
	if err := database.PingContext(ctx); err != nil {
		return Manifest{}, fmt.Errorf("open legacy database read-only: %w", err)
	}
	manifest := Manifest{SchemaVersion: 1, SID: sid, CapturedAt: capturedAt.UTC(), Skills: []Asset{}, MCPServers: []MCPServer{}, SkillBindings: []Binding{}, MCPBindings: []Binding{}, Presets: []PresetAsset{}, Results: []Result{}}
	if err := captureLegacySkills(ctx, database, &manifest); err != nil {
		return Manifest{}, err
	}
	assistants, err := captureLegacyAssistants(ctx, database)
	if err != nil {
		return Manifest{}, err
	}
	for _, assistant := range assistants {
		preset := assistant.preset
		preset.SkillBindingIDs = []string{}
		preset.MCPBindingIDs = []string{}
		manifest.Presets = append(manifest.Presets, preset)
	}
	captureLegacySkillBindings(&manifest, assistants)
	if err := captureLegacyMCP(ctx, database, &manifest, assistants); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func readonlySQLiteDSN(path string) string {
	uriPath := filepath.ToSlash(path)
	if filepath.VolumeName(path) != "" {
		uriPath = "/" + uriPath
	}
	value := &url.URL{Scheme: "file", Path: uriPath}
	query := value.Query()
	query.Set("mode", "ro")
	value.RawQuery = query.Encode()
	return value.String()
}

func captureLegacySkills(ctx context.Context, database *sql.DB, manifest *Manifest) error {
	rows, err := database.QueryContext(ctx, `SELECT id,name,COALESCE(description,''),path,source,enabled,deleted_at FROM skills ORDER BY id`)
	if err != nil {
		if legacyTableMissing(err) {
			return nil
		}
		return fmt.Errorf("inventory legacy skills: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var asset Asset
		var enabled int
		var deleted sql.NullInt64
		if err := rows.Scan(&asset.OldID, &asset.Name, &asset.Description, &asset.ContentPath, &asset.LegacySource, &enabled, &deleted); err != nil {
			return err
		}
		asset.Version = "legacy"
		asset.Enabled = enabled != 0
		asset.Deleted = deleted.Valid
		asset.BindingObjectIDs = []string{}
		asset.RequiredMCPServerIDs = []string{}
		manifest.Skills = append(manifest.Skills, asset)
	}
	return rows.Err()
}

func captureLegacyAssistants(ctx context.Context, database *sql.DB) ([]legacyAssistant, error) {
	definitions, found, err := captureLegacyAssistantDefinitions(ctx, database)
	if err != nil || found {
		return definitions, err
	}
	rows, err := database.QueryContext(ctx, `SELECT id,preset_agent_type,enabled_skills,custom_skill_names FROM assistants ORDER BY id`)
	if err != nil {
		if legacyTableMissing(err) {
			return []legacyAssistant{}, nil
		}
		return nil, fmt.Errorf("inventory legacy assistants: %w", err)
	}
	defer rows.Close()
	result := []legacyAssistant{}
	for rows.Next() {
		var id, agentType string
		var enabled, custom sql.NullString
		if err := rows.Scan(&id, &agentType, &enabled, &custom); err != nil {
			return nil, err
		}
		names := append(parseStringList(enabled.String), parseStringList(custom.String)...)
		engine := legacyEngine(agentType)
		result = append(result, legacyAssistant{
			id: id, engine: engine, skills: uniqueStrings(names), mcpMode: "auto", mcps: []string{},
			preset: PresetAsset{OldID: id, Name: id, Description: "", Engine: engine, Enabled: true, SkillIDs: uniqueStrings(names), MCPServerIDs: []string{}, ApprovalPolicy: "on_risk", MigrationIssues: []string{"legacy_assistant_metadata_projection_required"}},
		})
	}
	return result, rows.Err()
}

func captureLegacyAssistantDefinitions(ctx context.Context, database *sql.DB) ([]legacyAssistant, bool, error) {
	rows, err := database.QueryContext(ctx, `SELECT assistant_id,name,COALESCE(description,''),avatar_type,avatar_value,agent_id,rule_resource_type,rule_inline_content,default_model_mode,default_model_value,default_permission_mode,default_permission_value,default_skill_ids,custom_skill_names,default_mcps_mode,default_mcp_ids FROM assistant_definitions WHERE deleted_at IS NULL ORDER BY assistant_id`)
	if err != nil {
		if legacyTableMissing(err) {
			return nil, false, nil
		}
		return nil, true, fmt.Errorf("inventory legacy assistant definitions: %w", err)
	}
	defer rows.Close()
	result := []legacyAssistant{}
	for rows.Next() {
		var id, name, description, avatarType, agentID, ruleType, modelMode, permissionMode, skillIDs, customNames, mcpMode, mcpIDs string
		var avatarValue, ruleInline, modelValue, permissionValue sql.NullString
		if err := rows.Scan(&id, &name, &description, &avatarType, &avatarValue, &agentID, &ruleType, &ruleInline, &modelMode, &modelValue, &permissionMode, &permissionValue, &skillIDs, &customNames, &mcpMode, &mcpIDs); err != nil {
			return nil, true, err
		}
		skills := append(parseStringList(skillIDs), parseStringList(customNames)...)
		skills = uniqueStrings(skills)
		mcps := uniqueStrings(parseStringList(mcpIDs))
		engine := legacyEngine(agentID)
		issues := []string{}
		systemPrompt := ""
		if strings.EqualFold(ruleType, "inline") {
			systemPrompt = ruleInline.String
		} else if !strings.EqualFold(ruleType, "none") {
			issues = append(issues, "rule_resource_projection_required")
		}
		var avatar *string
		if !strings.EqualFold(avatarType, "none") && avatarValue.Valid && strings.TrimSpace(avatarValue.String) != "" {
			avatar, issues = legacyAvatar(avatarType, avatarValue.String, issues)
		}
		var modelID *string
		if strings.EqualFold(modelMode, "fixed") && modelValue.Valid && strings.TrimSpace(modelValue.String) != "" {
			value := modelValue.String
			modelID = &value
		}
		approvalPolicy, permissionIssue := legacyApprovalPolicy(permissionMode, permissionValue.String)
		if permissionIssue != "" {
			issues = append(issues, permissionIssue)
		}
		result = append(result, legacyAssistant{
			id: id, engine: engine, skills: skills, mcpMode: strings.ToLower(mcpMode), mcps: mcps,
			preset: PresetAsset{OldID: id, Name: name, Description: description, Avatar: avatar, Engine: engine, ModelID: modelID, SystemPrompt: systemPrompt, Enabled: true, SkillIDs: skills, MCPServerIDs: mcps, ApprovalPolicy: approvalPolicy, MigrationIssues: uniqueStrings(issues)},
		})
	}
	return result, true, rows.Err()
}

func legacyAvatar(kind, value string, issues []string) (*string, []string) {
	value = strings.TrimSpace(value)
	if strings.EqualFold(kind, "url") {
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return nil, append(issues, "avatar_resource_projection_required")
		}
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.Fragment = ""
		clean := parsed.String()
		return &clean, issues
	}
	clean := filepath.ToSlash(filepath.Clean(value))
	if filepath.IsAbs(value) || clean == ".." || strings.HasPrefix(clean, "../") || len(clean) > 2048 {
		return nil, append(issues, "avatar_resource_projection_required")
	}
	issues = append(issues, "avatar_resource_projection_required")
	return &clean, issues
}

func legacyApprovalPolicy(mode, value string) (string, string) {
	if !strings.EqualFold(mode, "fixed") {
		return "on_risk", ""
	}
	value = strings.ToLower(value)
	if strings.Contains(value, "full") || strings.Contains(value, "bypass") {
		return "never", ""
	}
	if strings.Contains(value, "ask") || strings.Contains(value, "plan") {
		return "always_ask", ""
	}
	return "on_risk", "permission_projection_required"
}

func captureLegacySkillBindings(manifest *Manifest, assistants []legacyAssistant) {
	byNameOrID := map[string]int{}
	for index := range manifest.Skills {
		byNameOrID[strings.ToLower(manifest.Skills[index].Name)] = index
		byNameOrID[strings.ToLower(manifest.Skills[index].OldID)] = index
	}
	for _, assistant := range assistants {
		resolvedSkillIDs := []string{}
		for _, name := range assistant.skills {
			bindingID := "legacy-skill-binding-" + assistant.id + "-" + safeInventoryID(name)
			index, ok := byNameOrID[strings.ToLower(name)]
			if !ok {
				manifest.Results = append(manifest.Results, Result{SourceID: bindingID, Kind: "skill_binding", Status: NeedsReview, Reason: "bound_skill_not_found:" + name})
				resolvedSkillIDs = append(resolvedSkillIDs, name)
				appendPresetBindingID(manifest, assistant.id, bindingID, true)
				continue
			}
			asset := &manifest.Skills[index]
			resolvedSkillIDs = append(resolvedSkillIDs, asset.OldID)
			asset.BindingObjectIDs = append(asset.BindingObjectIDs, assistant.id)
			binding := Binding{ID: "legacy-skill-binding-" + assistant.id + "-" + asset.OldID, SkillID: asset.OldID, Engine: assistant.engine, SubjectID: assistant.id, SubjectType: "assistant"}
			manifest.SkillBindings = append(manifest.SkillBindings, binding)
			manifest.Results = append(manifest.Results, Result{SourceID: binding.ID, Kind: "skill_binding", Status: NeedsReview, Reason: "assistant_preset_projection_required"})
			appendPresetBindingID(manifest, assistant.id, binding.ID, true)
		}
		setPresetSkillIDs(manifest, assistant.id, uniqueStrings(resolvedSkillIDs))
	}
}

func captureLegacyMCP(ctx context.Context, database *sql.DB, manifest *Manifest, assistants []legacyAssistant) error {
	oauthURLs, err := legacyOAuthURLs(ctx, database)
	if err != nil {
		return err
	}
	rows, err := database.QueryContext(ctx, `SELECT id,name,COALESCE(description,''),enabled,transport_type,transport_config,COALESCE(tools,'[]'),builtin,deleted_at FROM mcp_servers ORDER BY id`)
	if err != nil {
		if legacyTableMissing(err) {
			return nil
		}
		return fmt.Errorf("inventory legacy MCP servers: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, description, transportType, transportJSON, toolsJSON string
		var enabled, builtin int
		var deleted sql.NullInt64
		if err := rows.Scan(&id, &name, &description, &enabled, &transportType, &transportJSON, &toolsJSON, &builtin, &deleted); err != nil {
			return err
		}
		if deleted.Valid {
			manifest.Results = append(manifest.Results, Result{SourceID: id, Kind: "mcp_server", Status: Ready, Reason: "source_deleted"})
			continue
		}
		server, credentialRequired := redactedLegacyMCP(id, name, description, transportType, transportJSON, toolsJSON, enabled != 0, builtin != 0)
		if _, ok := oauthURLs[server.Transport.URL]; ok {
			credentialRequired = true
		}
		if credentialRequired {
			server.OAuthState = "needs_auth"
			manifest.Results = append(manifest.Results, Result{SourceID: "legacy-oauth-" + id, Kind: "oauth", Status: NeedsAuth, Reason: "credential_values_are_not_exported"})
		}
		manifest.MCPServers = append(manifest.MCPServers, server)
		for _, assistant := range assistants {
			if assistant.mcpMode == "fixed" {
				if !containsFold(assistant.mcps, id) {
					continue
				}
			} else if !server.Enabled {
				continue
			}
			binding := Binding{ID: "legacy-mcp-binding-" + assistant.id + "-" + id, ServerID: id, Engine: assistant.engine, SubjectID: assistant.id, SubjectType: "assistant"}
			manifest.MCPBindings = append(manifest.MCPBindings, binding)
			manifest.Results = append(manifest.Results, Result{SourceID: binding.ID, Kind: "mcp_binding", Status: NeedsReview, Reason: "assistant_preset_projection_required"})
			appendPresetMCPID(manifest, assistant.id, id)
			appendPresetBindingID(manifest, assistant.id, binding.ID, false)
		}
	}
	return rows.Err()
}

func appendPresetBindingID(manifest *Manifest, assistantID, bindingID string, skill bool) {
	for index := range manifest.Presets {
		if manifest.Presets[index].OldID != assistantID {
			continue
		}
		if skill {
			manifest.Presets[index].SkillBindingIDs = uniqueStrings(append(manifest.Presets[index].SkillBindingIDs, bindingID))
		} else {
			manifest.Presets[index].MCPBindingIDs = uniqueStrings(append(manifest.Presets[index].MCPBindingIDs, bindingID))
		}
		return
	}
}

func setPresetSkillIDs(manifest *Manifest, assistantID string, ids []string) {
	for index := range manifest.Presets {
		if manifest.Presets[index].OldID == assistantID {
			manifest.Presets[index].SkillIDs = ids
			return
		}
	}
}

func appendPresetMCPID(manifest *Manifest, assistantID, serverID string) {
	for index := range manifest.Presets {
		if manifest.Presets[index].OldID == assistantID {
			manifest.Presets[index].MCPServerIDs = uniqueStrings(append(manifest.Presets[index].MCPServerIDs, serverID))
			return
		}
	}
}

func containsFold(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(value, target) {
			return true
		}
	}
	return false
}

func redactedLegacyMCP(id, name, description, transportType, raw, tools string, enabled, builtin bool) (MCPServer, bool) {
	var config map[string]json.RawMessage
	_ = json.Unmarshal([]byte(raw), &config)
	kind := strings.ToLower(transportType)
	if kind != "stdio" && kind != "sse" {
		kind = "http"
	}
	transport := MCPTransport{Kind: kind, Args: []string{}, EnvironmentCredentialIDs: map[string]string{}, HeaderCredentialIDs: map[string]string{}}
	credentialRequired := false
	if kind == "stdio" {
		_ = json.Unmarshal(config["command"], &transport.Command)
		if strings.TrimSpace(transport.Command) == "" {
			transport.Command = "legacy-command-requires-review"
		}
		var environment map[string]json.RawMessage
		_ = json.Unmarshal(config["env"], &environment)
		for index, key := range sortedKeys(environment) {
			transport.EnvironmentCredentialIDs[key] = fmt.Sprintf("legacy-mcp-%s-env-%d", safeInventoryID(id), index+1)
			credentialRequired = true
		}
	} else {
		var rawURL string
		_ = json.Unmarshal(config["url"], &rawURL)
		transport.URL = sanitizedLegacyURL(rawURL)
		var headers map[string]json.RawMessage
		_ = json.Unmarshal(config["headers"], &headers)
		for index, key := range sortedKeys(headers) {
			transport.HeaderCredentialIDs[key] = fmt.Sprintf("legacy-mcp-%s-header-%d", safeInventoryID(id), index+1)
			credentialRequired = true
		}
	}
	source := "user"
	if builtin {
		source = "managed"
	}
	return MCPServer{ID: id, Name: name, Description: description, Source: source, Transport: transport, Enabled: enabled, ToolPolicy: "all", AllowedTools: legacyToolNames(tools), OAuthState: "none"}, credentialRequired
}

func legacyOAuthURLs(ctx context.Context, database *sql.DB) (map[string]struct{}, error) {
	rows, err := database.QueryContext(ctx, `SELECT server_url FROM oauth_tokens ORDER BY server_url`)
	if err != nil {
		if legacyTableMissing(err) {
			return map[string]struct{}{}, nil
		}
		return nil, fmt.Errorf("inventory legacy OAuth metadata: %w", err)
	}
	defer rows.Close()
	result := map[string]struct{}{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		result[sanitizedLegacyURL(value)] = struct{}{}
	}
	return result, rows.Err()
}

func sanitizedLegacyURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "https://legacy.invalid/"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = "/"
	parsed.RawPath = ""
	return parsed.String()
}

func legacyToolNames(value string) []string {
	var raw []any
	if json.Unmarshal([]byte(value), &raw) != nil {
		return []string{}
	}
	result := []string{}
	for _, item := range raw {
		switch typed := item.(type) {
		case string:
			result = append(result, typed)
		case map[string]any:
			if name, ok := typed["name"].(string); ok {
				result = append(result, name)
			}
		}
	}
	return uniqueStrings(result)
}

func parseStringList(value string) []string {
	var values []string
	if json.Unmarshal([]byte(value), &values) != nil {
		return []string{}
	}
	return values
}

func uniqueStrings(values []string) []string {
	seen := map[string]string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			seen[strings.ToLower(value)] = value
		}
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, seen[key])
	}
	return result
}

func sortedKeys(values map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func legacyEngine(value string) string {
	value = strings.ToLower(value)
	if strings.Contains(value, "codex") {
		return "codex"
	}
	if strings.Contains(value, "kimi") {
		return "kimi"
	}
	return "harness"
}

func safeInventoryID(value string) string {
	var builder strings.Builder
	for _, character := range strings.ToLower(value) {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-' || character == '_' {
			builder.WriteRune(character)
		} else {
			builder.WriteByte('-')
		}
	}
	result := strings.Trim(builder.String(), "-")
	if result == "" {
		return "asset"
	}
	return result
}

func legacyTableMissing(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "no such table")
}

func validSID(value string) bool {
	return strings.HasPrefix(strings.ToUpper(value), "S-1-") && len(value) <= 184
}
