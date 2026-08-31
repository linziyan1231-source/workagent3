package skillmigration

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillruntime"

	_ "modernc.org/sqlite"
)

type Status string

const (
	Ready       Status = "ready"
	NeedsAuth   Status = "needs_auth"
	NeedsReview Status = "needs_review"
	Failed      Status = "failed"
	running     Status = "running"
)

type Asset struct {
	OldID                string   `json:"oldId"`
	Name                 string   `json:"name"`
	Description          string   `json:"description"`
	Version              string   `json:"version"`
	LegacySource         string   `json:"legacySource"`
	Enabled              bool     `json:"enabled"`
	Deleted              bool     `json:"deleted"`
	ContentPath          string   `json:"contentPath"`
	BindingObjectIDs     []string `json:"bindingObjectIds"`
	RequiredMCPServerIDs []string `json:"requiredMcpServerIds"`
}

type Manifest struct {
	SchemaVersion int         `json:"schemaVersion"`
	SID           string      `json:"sid"`
	CapturedAt    time.Time   `json:"capturedAt"`
	Skills        []Asset     `json:"skills"`
	MCPServers    []MCPServer `json:"mcpServers"`
	SkillBindings []Binding   `json:"skillBindings"`
	MCPBindings   []Binding   `json:"mcpBindings"`
	Results       []Result    `json:"results"`
}

type MCPServer struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	Source       string       `json:"source"`
	Transport    MCPTransport `json:"transport"`
	Enabled      bool         `json:"enabled"`
	ToolPolicy   string       `json:"toolPolicy"`
	AllowedTools []string     `json:"allowedTools"`
	OAuthState   string       `json:"oauthState"`
}

type MCPTransport struct {
	Kind                     string            `json:"kind"`
	Command                  string            `json:"command,omitempty"`
	Args                     []string          `json:"args,omitempty"`
	URL                      string            `json:"url,omitempty"`
	EnvironmentCredentialIDs map[string]string `json:"environmentCredentialIds,omitempty"`
	HeaderCredentialIDs      map[string]string `json:"headerCredentialIds,omitempty"`
}

type Binding struct {
	ID          string `json:"id"`
	SkillID     string `json:"skillId,omitempty"`
	ServerID    string `json:"serverId,omitempty"`
	Engine      string `json:"engine"`
	SubjectID   string `json:"subjectId"`
	SubjectType string `json:"subjectType"`
}

type Result struct {
	SourceID string `json:"sourceId"`
	TargetID string `json:"targetId,omitempty"`
	Kind     string `json:"kind"`
	Status   Status `json:"status"`
	Reason   string `json:"reason,omitempty"`
}

type MCPReadiness interface {
	MigrationStatus(context.Context, []string) (Status, string)
}

type CredentialReadiness interface {
	CredentialReady(context.Context, string) bool
}

type Store struct {
	db       *sql.DB
	skills   *skillruntime.Store
	releases map[string]string
	now      func() time.Time
	newID    func() (string, error)
}

func Open(databasePath string, skills *skillruntime.Store, releasedBuiltinPaths map[string]string) (*Store, error) {
	if skills == nil {
		return nil, errors.New("skill runtime is required")
	}
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return nil, fmt.Errorf("open skill migration journal: %w", err)
	}
	database.SetMaxOpenConns(1)
	_, err = database.Exec(`
CREATE TABLE IF NOT EXISTS skill_migrations (
  source_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  desired_enabled INTEGER NOT NULL CHECK (desired_enabled IN (0,1)),
  deleted INTEGER NOT NULL CHECK (deleted IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('running','ready','needs_auth','needs_review','failed')),
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_migrations (
  source_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ready','needs_auth','needs_review','failed')),
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`)
	if err != nil {
		database.Close()
		return nil, fmt.Errorf("migrate skill migration journal: %w", err)
	}
	return &Store{db: database, skills: skills, releases: releasedBuiltinPaths, now: time.Now, newID: randomID}, nil
}

func (s *Store) MigrateMCP(ctx context.Context, assets []MCPServer, catalog *mcpruntime.Catalog, credentials CredentialReadiness, managedReplacements map[string]mcpruntime.Server) ([]Result, error) {
	if catalog == nil {
		return nil, errors.New("MCP catalog is required")
	}
	results := make([]Result, 0, len(assets))
	seen := make(map[string]struct{}, len(assets))
	for _, asset := range assets {
		if _, duplicate := seen[asset.ID]; duplicate {
			return nil, fmt.Errorf("duplicate source MCP server: %s", asset.ID)
		}
		seen[asset.ID] = struct{}{}
		results = append(results, s.migrateMCPOne(ctx, asset, catalog, credentials, managedReplacements))
	}
	return results, nil
}

func (s *Store) MCPMapping(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT source_id,target_id FROM mcp_migrations WHERE target_id != 'unassigned'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	mapping := map[string]string{}
	for rows.Next() {
		var source, target string
		if err := rows.Scan(&source, &target); err != nil {
			return nil, err
		}
		mapping[source] = target
	}
	return mapping, rows.Err()
}

func (s *Store) MCPResults(ctx context.Context) ([]Result, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT source_id,target_id,status,reason FROM mcp_migrations ORDER BY source_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := make([]Result, 0)
	for rows.Next() {
		result := Result{Kind: "mcp_server"}
		if err := rows.Scan(&result.SourceID, &result.TargetID, &result.Status, &result.Reason); err != nil {
			return nil, err
		}
		if result.TargetID == "unassigned" {
			result.TargetID = ""
		}
		if result.Status == running {
			result.Status = NeedsReview
			result.Reason = "migration_interrupted_retry_required"
		}
		results = append(results, result)
	}
	return results, rows.Err()
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Migrate(ctx context.Context, manifest Manifest, mcp MCPReadiness) ([]Result, error) {
	if manifest.SchemaVersion != 1 || !strings.HasPrefix(manifest.SID, "S-1-") || manifest.CapturedAt.IsZero() {
		return nil, errors.New("invalid migration manifest")
	}
	results := make([]Result, 0, len(manifest.Skills))
	seen := make(map[string]struct{}, len(manifest.Skills))
	for _, asset := range manifest.Skills {
		if _, duplicate := seen[asset.OldID]; duplicate {
			return nil, fmt.Errorf("duplicate source skill: %s", asset.OldID)
		}
		seen[asset.OldID] = struct{}{}
		results = append(results, s.migrateOne(ctx, asset, mcp))
	}
	return results, nil
}

func (s *Store) Results(ctx context.Context) ([]Result, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT source_id,target_id,status,reason FROM skill_migrations ORDER BY source_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := make([]Result, 0)
	for rows.Next() {
		var result Result
		if err := rows.Scan(&result.SourceID, &result.TargetID, &result.Status, &result.Reason); err != nil {
			return nil, err
		}
		if result.TargetID == "unassigned" {
			result.TargetID = ""
		}
		result.Kind = "skill"
		if result.Status == running {
			result.Status = NeedsReview
			result.Reason = "migration_interrupted_retry_required"
		}
		results = append(results, result)
	}
	return results, rows.Err()
}

func (s *Store) migrateOne(ctx context.Context, asset Asset, mcp MCPReadiness) Result {
	if err := validateAsset(asset); err != nil {
		return s.record(ctx, asset, "", Failed, err.Error())
	}
	targetID, err := s.targetID(ctx, asset)
	if err != nil {
		return Result{SourceID: asset.OldID, Kind: "skill", Status: Failed, Reason: "migration_journal_failed"}
	}
	if started := s.record(ctx, asset, targetID, running, ""); started.Status == Failed {
		return started
	}
	if asset.Deleted {
		if existing, getErr := s.skills.Get(ctx, targetID); getErr == nil && existing.Source != "builtin" && existing.Source != "managed" {
			if removeErr := s.skills.Remove(ctx, targetID); removeErr != nil {
				return s.record(ctx, asset, targetID, Failed, "remove_deleted_skill_failed")
			}
		}
		return s.record(ctx, asset, targetID, Ready, "source_deleted")
	}
	sourcePath, source, state, reason := s.resolveSource(asset)
	if state != "" {
		return s.record(ctx, asset, targetID, state, reason)
	}
	if existing, getErr := s.skills.GetByName(ctx, asset.Name); getErr == nil && existing.ID != targetID {
		return s.record(ctx, asset, targetID, NeedsReview, "skill_name_conflict")
	} else if getErr != nil && !errors.Is(getErr, skillruntime.ErrNotFound) {
		return s.record(ctx, asset, targetID, Failed, "skill_catalog_lookup_failed")
	}
	dependencyStatus, dependencyReason := Ready, ""
	if len(asset.RequiredMCPServerIDs) != 0 {
		if mcp == nil {
			dependencyStatus, dependencyReason = NeedsReview, "mcp_readiness_unavailable"
		} else {
			dependencyStatus, dependencyReason = mcp.MigrationStatus(ctx, asset.RequiredMCPServerIDs)
			if dependencyStatus != Ready && dependencyStatus != NeedsAuth && dependencyStatus != NeedsReview && dependencyStatus != Failed {
				dependencyStatus, dependencyReason = Failed, "invalid_mcp_migration_status"
			}
		}
	}
	desiredEnabled := asset.Enabled && dependencyStatus == Ready
	entry, getErr := s.skills.Get(ctx, targetID)
	if errors.Is(getErr, skillruntime.ErrNotFound) {
		entry, err = s.skills.Install(ctx, skillruntime.InstallInput{
			Entry: skillruntime.Entry{
				ID: targetID, Name: asset.Name, Description: asset.Description, Version: asset.Version, Source: source,
				Enabled: desiredEnabled, RequiredMCPServerIDs: asset.RequiredMCPServerIDs,
			},
			SourceDirectory: sourcePath,
		})
	} else if getErr == nil {
		entry, err = s.skills.SetEnabled(ctx, targetID, desiredEnabled)
	} else {
		err = getErr
	}
	if err != nil {
		return s.record(ctx, asset, targetID, Failed, "skill_install_failed: "+err.Error())
	}
	_ = entry
	if dependencyStatus != Ready {
		return s.record(ctx, asset, targetID, dependencyStatus, dependencyReason)
	}
	return s.record(ctx, asset, targetID, Ready, "")
}

func (s *Store) migrateMCPOne(ctx context.Context, asset MCPServer, catalog *mcpruntime.Catalog, credentials CredentialReadiness, managed map[string]mcpruntime.Server) Result {
	if strings.TrimSpace(asset.ID) == "" || strings.TrimSpace(asset.Name) == "" || (asset.Source != "managed" && asset.Source != "user") {
		return s.recordMCP(ctx, asset.ID, "", Failed, "invalid_mcp_metadata")
	}
	var candidate mcpruntime.Server
	preferredID := ""
	if asset.Source == "managed" {
		var ok bool
		candidate, ok = managed[strings.ToLower(asset.Name)]
		if !ok {
			candidate, ok = managed[asset.ID]
		}
		if !ok {
			return s.recordMCP(ctx, asset.ID, "", NeedsReview, "managed_mcp_replacement_missing")
		}
		preferredID = candidate.ID
	} else {
		candidate = mcpruntime.Server{
			Name: asset.Name, Description: asset.Description, Source: "user", Enabled: asset.Enabled,
			Transport: mcpruntime.Transport{
				Kind: asset.Transport.Kind, Command: asset.Transport.Command, Args: asset.Transport.Args, URL: asset.Transport.URL,
				EnvironmentCredentialIDs: asset.Transport.EnvironmentCredentialIDs, HeaderCredentialIDs: asset.Transport.HeaderCredentialIDs,
			},
			ToolPolicy: asset.ToolPolicy, AllowedTools: asset.AllowedTools, OAuthState: asset.OAuthState, Health: "needs_review",
		}
	}
	candidate.Enabled = asset.Enabled
	targetID, err := s.mcpTargetID(ctx, asset, catalog, preferredID)
	if err != nil {
		return Result{SourceID: asset.ID, Kind: "mcp_server", Status: Failed, Reason: "migration_journal_failed"}
	}
	if started := s.recordMCP(ctx, asset.ID, targetID, running, ""); started.Status == Failed {
		return started
	}
	candidate.ID = targetID
	status, reason := mcpCandidateStatus(ctx, candidate, credentials, asset.Source == "managed")
	if status == NeedsReview && candidate.Source == "user" && candidate.Transport.Kind == "stdio" {
		candidate.Enabled = false
	}
	if status == NeedsAuth {
		candidate.OAuthState = "needs_auth"
	}
	_, getErr := catalog.Get(ctx, targetID)
	if errors.Is(getErr, mcpruntime.ErrNotFound) {
		_, err = catalog.Create(ctx, candidate)
	} else if getErr == nil {
		_, err = catalog.Replace(ctx, candidate)
	} else {
		err = getErr
	}
	if err != nil {
		return s.recordMCP(ctx, asset.ID, targetID, NeedsReview, "mcp_definition_requires_review")
	}
	return s.recordMCP(ctx, asset.ID, targetID, status, reason)
}

func mcpCandidateStatus(ctx context.Context, server mcpruntime.Server, credentials CredentialReadiness, managed bool) (Status, string) {
	if server.OAuthState == "needs_auth" {
		return NeedsAuth, "oauth_reauthorization_required"
	}
	credentialIDs := make([]string, 0, len(server.Transport.EnvironmentCredentialIDs)+len(server.Transport.HeaderCredentialIDs))
	for _, id := range server.Transport.EnvironmentCredentialIDs {
		credentialIDs = append(credentialIDs, id)
	}
	for _, id := range server.Transport.HeaderCredentialIDs {
		credentialIDs = append(credentialIDs, id)
	}
	if server.OAuthState == "ready" && len(credentialIDs) == 0 {
		return NeedsAuth, "oauth_credential_reference_missing"
	}
	for _, id := range credentialIDs {
		if credentials == nil || !credentials.CredentialReady(ctx, id) {
			return NeedsAuth, "credential_not_ready:" + id
		}
	}
	if managed {
		switch server.Health {
		case "healthy":
			return Ready, ""
		case "unavailable":
			return Failed, "managed_mcp_unavailable"
		default:
			return NeedsReview, "managed_mcp_health_check_required"
		}
	}
	if server.Transport.Kind == "stdio" {
		return NeedsReview, "user_stdio_requires_explicit_program_approval"
	}
	return NeedsReview, "connection_test_required"
}

func (s *Store) mcpTargetID(ctx context.Context, asset MCPServer, catalog *mcpruntime.Catalog, preferred string) (string, error) {
	var target string
	err := s.db.QueryRowContext(ctx, `SELECT target_id FROM mcp_migrations WHERE source_id=?`, asset.ID).Scan(&target)
	if err == nil && target != "unassigned" {
		return target, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if preferred != "" {
		existing, getErr := catalog.Get(ctx, preferred)
		if errors.Is(getErr, mcpruntime.ErrNotFound) || (getErr == nil && existing.Source == "managed" && strings.EqualFold(existing.Name, asset.Name)) {
			return preferred, nil
		}
		if getErr != nil {
			return "", getErr
		}
		return s.newID()
	}
	if validID.MatchString(asset.ID) {
		_, getErr := catalog.Get(ctx, asset.ID)
		if errors.Is(getErr, mcpruntime.ErrNotFound) {
			return asset.ID, nil
		}
		if getErr != nil {
			return "", getErr
		}
	}
	return s.newID()
}

func (s *Store) recordMCP(ctx context.Context, sourceID, targetID string, status Status, reason string) Result {
	if targetID == "" {
		targetID = "unassigned"
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO mcp_migrations(source_id,target_id,status,reason,updated_at) VALUES(?,?,?,?,?)
ON CONFLICT(source_id) DO UPDATE SET target_id=excluded.target_id,status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`,
		sourceID, targetID, status, reason, s.now().UTC().UnixMilli())
	if err != nil {
		return Result{SourceID: sourceID, Kind: "mcp_server", Status: Failed, Reason: "migration_journal_failed"}
	}
	result := Result{SourceID: sourceID, TargetID: targetID, Kind: "mcp_server", Status: status, Reason: reason}
	if targetID == "unassigned" {
		result.TargetID = ""
	}
	return result
}

func RemapSkillDependencies(skills []Asset, mapping map[string]string) ([]Asset, error) {
	result := make([]Asset, len(skills))
	for index, skill := range skills {
		result[index] = skill
		result[index].RequiredMCPServerIDs = make([]string, len(skill.RequiredMCPServerIDs))
		for dependencyIndex, oldID := range skill.RequiredMCPServerIDs {
			targetID, ok := mapping[oldID]
			if !ok {
				targetID = oldID
			}
			result[index].RequiredMCPServerIDs[dependencyIndex] = targetID
		}
	}
	return result, nil
}

func (s *Store) targetID(ctx context.Context, asset Asset) (string, error) {
	var target string
	err := s.db.QueryRowContext(ctx, `SELECT target_id FROM skill_migrations WHERE source_id=?`, asset.OldID).Scan(&target)
	if err == nil {
		if target != "unassigned" {
			return target, nil
		}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if asset.LegacySource == "builtin" {
		existing, getErr := s.skills.GetByName(ctx, asset.Name)
		if getErr == nil && (existing.Source == "builtin" || existing.Source == "managed") {
			return existing.ID, nil
		}
		if getErr != nil && !errors.Is(getErr, skillruntime.ErrNotFound) {
			return "", getErr
		}
	}
	if validID.MatchString(asset.OldID) {
		existing, getErr := s.skills.Get(ctx, asset.OldID)
		if errors.Is(getErr, skillruntime.ErrNotFound) || (getErr == nil && asset.LegacySource == "builtin" && (existing.Source == "builtin" || existing.Source == "managed") && strings.EqualFold(existing.Name, asset.Name)) {
			return asset.OldID, nil
		}
		if getErr != nil {
			return "", getErr
		}
	}
	return s.newID()
}

func (s *Store) resolveSource(asset Asset) (string, string, Status, string) {
	switch asset.LegacySource {
	case "builtin":
		path := s.releases[strings.ToLower(asset.Name)]
		if !filepath.IsAbs(path) {
			return "", "", NeedsReview, "released_builtin_missing"
		}
		return path, "builtin", "", ""
	case "user":
		if info, err := os.Stat(asset.ContentPath); err != nil || !info.IsDir() {
			return "", "", NeedsReview, "source_path_missing"
		}
		return asset.ContentPath, "user", "", ""
	case "market":
		if info, err := os.Stat(asset.ContentPath); err != nil || !info.IsDir() {
			return "", "", NeedsReview, "source_path_missing"
		}
		return asset.ContentPath, "market", "", ""
	case "extension", "cron":
		return "", "", NeedsReview, "legacy_executable_source_requires_managed_replacement"
	default:
		return "", "", Failed, "invalid_legacy_source"
	}
}

func (s *Store) record(ctx context.Context, asset Asset, targetID string, status Status, reason string) Result {
	if targetID == "" {
		targetID = "unassigned"
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO skill_migrations(source_id,target_id,source_path,desired_enabled,deleted,status,reason,updated_at)
VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET target_id=excluded.target_id,source_path=excluded.source_path,
desired_enabled=excluded.desired_enabled,deleted=excluded.deleted,status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`,
		asset.OldID, targetID, asset.ContentPath, asset.Enabled, asset.Deleted, status, reason, s.now().UTC().UnixMilli())
	if err != nil {
		return Result{SourceID: asset.OldID, Kind: "skill", Status: Failed, Reason: "migration_journal_failed"}
	}
	result := Result{SourceID: asset.OldID, TargetID: targetID, Kind: "skill", Status: status, Reason: reason}
	if targetID == "unassigned" {
		result.TargetID = ""
	}
	return result
}

func (m Manifest) Marshal() ([]byte, error) {
	return json.MarshalIndent(m, "", "  ")
}

var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func validateAsset(asset Asset) error {
	if strings.TrimSpace(asset.OldID) == "" || strings.TrimSpace(asset.Name) == "" || strings.TrimSpace(asset.Version) == "" {
		return errors.New("invalid_skill_metadata")
	}
	if !asset.Deleted && asset.LegacySource != "builtin" && !filepath.IsAbs(asset.ContentPath) {
		return errors.New("source_path_must_be_absolute")
	}
	for _, id := range asset.RequiredMCPServerIDs {
		if strings.TrimSpace(id) == "" {
			return errors.New("invalid_mcp_dependency")
		}
	}
	return nil
}

func randomID() (string, error) {
	value := make([]byte, 12)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return "migrated-" + hex.EncodeToString(value), nil
}
