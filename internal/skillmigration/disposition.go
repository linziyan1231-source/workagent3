package skillmigration

import (
	"context"
	"database/sql"
	"errors"

	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillruntime"
)

// Disposition errors returned by the administrator recovery operations (W14).
var (
	ErrMigrationItemNotFound = errors.New("migration item not found")
	ErrMigrationItemSettled  = errors.New("migration item is not awaiting disposition")
	ErrMigrationNoTarget     = errors.New("migration item has no projection target")
)

// migrationJournalTable maps a journal kind to its table. The fixed switch
// keeps table names out of caller-controlled input.
func migrationJournalTable(kind string) (string, error) {
	switch kind {
	case "skill":
		return "skill_migrations", nil
	case "mcp_server":
		return "mcp_migrations", nil
	case "preset", "skill_binding", "mcp_binding":
		return "preset_migrations", nil
	}
	return "", errors.New("invalid migration kind")
}

func migrationActionable(status Status) bool {
	return status == NeedsAuth || status == NeedsReview || status == Failed || status == running
}

func (s *Store) journalState(ctx context.Context, kind, sourceID string) (string, Status, error) {
	table, err := migrationJournalTable(kind)
	if err != nil {
		return "", "", err
	}
	var target string
	var status Status
	err = s.db.QueryRowContext(ctx, `SELECT target_id,status FROM `+table+` WHERE source_id=?`, sourceID).Scan(&target, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrMigrationItemNotFound
	}
	if err != nil {
		return "", "", err
	}
	return target, status, nil
}

// MarkResolved settles an actionable item the administrator handled outside
// the migrator (a manual fix verified by a human).
func (s *Store) MarkResolved(ctx context.Context, kind, sourceID string) (Result, error) {
	target, status, err := s.journalState(ctx, kind, sourceID)
	if err != nil {
		return Result{}, err
	}
	if !migrationActionable(status) {
		return Result{}, ErrMigrationItemSettled
	}
	table, _ := migrationJournalTable(kind)
	if _, err := s.db.ExecContext(ctx, `UPDATE `+table+` SET status='ready',reason='manually_resolved',updated_at=? WHERE source_id=?`, s.now().UTC().UnixMilli(), sourceID); err != nil {
		return Result{}, err
	}
	if target == "unassigned" {
		target = ""
	}
	return Result{SourceID: sourceID, TargetID: target, Kind: kind, Status: Ready, Reason: "manually_resolved"}, nil
}

// RetryMCP re-evaluates an actionable MCP journal row against the live catalog
// and credential broker, so a fixed credential or completed OAuth grant flips
// the item back to ready without rerunning the whole migrator.
func (s *Store) RetryMCP(ctx context.Context, sourceID string, catalog *mcpruntime.Catalog, credentials CredentialReadiness) (Result, error) {
	if catalog == nil {
		return Result{}, errors.New("MCP catalog is required")
	}
	target, status, err := s.journalState(ctx, "mcp_server", sourceID)
	if err != nil {
		return Result{}, err
	}
	if !migrationActionable(status) {
		return Result{}, ErrMigrationItemSettled
	}
	if target == "unassigned" {
		return Result{}, ErrMigrationNoTarget
	}
	server, err := catalog.Get(ctx, target)
	if errors.Is(err, mcpruntime.ErrNotFound) {
		return s.recordMCP(ctx, sourceID, target, NeedsReview, "mcp_definition_requires_review"), nil
	}
	if err != nil {
		return Result{}, err
	}
	// The migrator persists needs_auth into the catalog OAuth state; a retry
	// must re-judge from the actual credential references instead of trusting
	// that sticky marker. Servers whose credential is still missing or unready
	// (revoked grant, never-exported legacy secret) stay needs_auth.
	if server.OAuthState == "needs_auth" {
		server.OAuthState = "ready"
	}
	next, reason := mcpCandidateStatus(ctx, server, credentials, server.Source == "managed")
	return s.recordMCP(ctx, sourceID, target, next, reason), nil
}

// RetrySkill re-evaluates an actionable skill journal row: it re-checks the
// MCP dependencies of the projected skill and restores the desired enabled
// state.
func (s *Store) RetrySkill(ctx context.Context, sourceID string, mcp MCPReadiness) (Result, error) {
	var target, sourcePath string
	var desiredEnabled, deleted bool
	var status Status
	err := s.db.QueryRowContext(ctx, `SELECT target_id,source_path,desired_enabled,deleted,status FROM skill_migrations WHERE source_id=?`, sourceID).Scan(&target, &sourcePath, &desiredEnabled, &deleted, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return Result{}, ErrMigrationItemNotFound
	}
	if err != nil {
		return Result{}, err
	}
	if !migrationActionable(status) {
		return Result{}, ErrMigrationItemSettled
	}
	asset := Asset{OldID: sourceID, ContentPath: sourcePath, Enabled: desiredEnabled, Deleted: deleted}
	if deleted {
		return s.record(ctx, asset, target, Ready, "source_deleted"), nil
	}
	if target == "unassigned" {
		return Result{}, ErrMigrationNoTarget
	}
	entry, err := s.skills.Get(ctx, target)
	if errors.Is(err, skillruntime.ErrNotFound) {
		return s.record(ctx, asset, target, NeedsReview, "skill_projection_missing"), nil
	}
	if err != nil {
		return Result{}, err
	}
	dependencyStatus, dependencyReason := Ready, ""
	if len(entry.RequiredMCPServerIDs) != 0 {
		if mcp == nil {
			dependencyStatus, dependencyReason = NeedsReview, "mcp_readiness_unavailable"
		} else {
			dependencyStatus, dependencyReason = mcp.MigrationStatus(ctx, entry.RequiredMCPServerIDs)
			if dependencyStatus != Ready && dependencyStatus != NeedsAuth && dependencyStatus != NeedsReview && dependencyStatus != Failed {
				dependencyStatus, dependencyReason = Failed, "invalid_mcp_migration_status"
			}
		}
	}
	if _, err := s.skills.SetEnabled(ctx, target, desiredEnabled && dependencyStatus == Ready); err != nil {
		return s.record(ctx, asset, target, Failed, "skill_install_failed: "+err.Error()), nil
	}
	return s.record(ctx, asset, target, dependencyStatus, dependencyReason), nil
}

// PresetResult reads back one Preset/binding journal row after the Preset
// projection publisher re-ran.
func (s *Store) PresetResult(ctx context.Context, sourceID string) (Result, error) {
	var result Result
	err := s.db.QueryRowContext(ctx, `SELECT source_id,target_id,kind,status,reason FROM preset_migrations WHERE source_id=?`, sourceID).
		Scan(&result.SourceID, &result.TargetID, &result.Kind, &result.Status, &result.Reason)
	if errors.Is(err, sql.ErrNoRows) {
		return Result{}, ErrMigrationItemNotFound
	}
	if err != nil {
		return Result{}, err
	}
	return result, nil
}
