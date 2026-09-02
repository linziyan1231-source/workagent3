package skillmigration

import (
	"context"
	"errors"
	"testing"

	"workagent3/internal/mcpruntime"
)

func TestMarkResolvedSettlesActionableItem(t *testing.T) {
	ctx := context.Background()
	migration, _ := openMigration(t, nil)
	source := writePackage(t, "user-source", "user-skill", "original")
	manifest := validManifest(Asset{
		OldID: "legacy-user", Name: "User Skill", Version: "1", LegacySource: "user",
		Enabled: true, ContentPath: source, RequiredMCPServerIDs: []string{"private-mcp"},
	})
	first, err := migration.Migrate(ctx, manifest, readiness{status: NeedsAuth, reason: "mcp_token_expired"})
	if err != nil || first[0].Status != NeedsAuth {
		t.Fatalf("unexpected migration: %#v, %v", first, err)
	}

	resolved, err := migration.MarkResolved(ctx, "skill", "legacy-user")
	if err != nil || resolved.Status != Ready || resolved.Reason != "manually_resolved" || resolved.TargetID != first[0].TargetID {
		t.Fatalf("unexpected resolve: %#v, %v", resolved, err)
	}
	results, err := migration.Results(ctx)
	if err != nil || len(results) != 1 || results[0].Status != Ready || results[0].Reason != "manually_resolved" {
		t.Fatalf("journal not settled: %#v, %v", results, err)
	}
	if _, err := migration.MarkResolved(ctx, "skill", "legacy-user"); !errors.Is(err, ErrMigrationItemSettled) {
		t.Fatalf("settled item should reject resolve: %v", err)
	}
	if _, err := migration.MarkResolved(ctx, "skill", "missing"); !errors.Is(err, ErrMigrationItemNotFound) {
		t.Fatalf("unknown item should report not found: %v", err)
	}
	if _, err := migration.MarkResolved(ctx, "bogus", "legacy-user"); err == nil {
		t.Fatal("invalid kind should fail")
	}
}

func TestMarkResolvedPresetBinding(t *testing.T) {
	ctx := context.Background()
	migration, _ := openMigration(t, nil)
	if err := migration.ReplacePresetResults(ctx, []Result{{SourceID: "binding-1", TargetID: "preset-1", Kind: "skill_binding", Status: NeedsReview, Reason: "assistant_preset_projection_required"}}); err != nil {
		t.Fatal(err)
	}
	resolved, err := migration.MarkResolved(ctx, "skill_binding", "binding-1")
	if err != nil || resolved.Status != Ready || resolved.Kind != "skill_binding" {
		t.Fatalf("unexpected preset resolve: %#v, %v", resolved, err)
	}
	if _, err := migration.PresetResult(ctx, "binding-1"); err != nil {
		t.Fatalf("preset result missing after resolve: %v", err)
	}
	if _, err := migration.PresetResult(ctx, "missing"); !errors.Is(err, ErrMigrationItemNotFound) {
		t.Fatalf("unknown preset item should report not found: %v", err)
	}
}

func TestRetryMCPReevaluatesCredentialReadiness(t *testing.T) {
	ctx := context.Background()
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = catalog.Close() })
	migration, _ := openMigration(t, nil)
	asset := MCPServer{
		ID: "legacy-mcp", Name: "Legacy MCP", Source: "user", Enabled: true, ToolPolicy: "all",
		Transport: MCPTransport{Kind: "http", URL: "https://mcp.example.com/", HeaderCredentialIDs: map[string]string{"Authorization": "cred-1"}},
	}
	first, err := migration.MigrateMCP(ctx, []MCPServer{asset}, catalog, credentialStates{"cred-1": false}, nil)
	if err != nil || len(first) != 1 || first[0].Status != NeedsAuth {
		t.Fatalf("unexpected MCP migration: %#v, %v", first, err)
	}

	if _, err := migration.RetryMCP(ctx, "legacy-mcp", catalog, credentialStates{"cred-1": false}); err != nil {
		t.Fatal(err)
	}
	retried, err := migration.RetryMCP(ctx, "legacy-mcp", catalog, credentialStates{"cred-1": true})
	if err != nil {
		t.Fatal(err)
	}
	// The credential is fixed, but a user-managed HTTP server still needs an
	// explicit connection test before it can flip to ready.
	if retried.Status != NeedsReview || retried.Reason != "connection_test_required" || retried.TargetID != "legacy-mcp" {
		t.Fatalf("unexpected retry outcome: %#v", retried)
	}
	if _, err := migration.RetryMCP(ctx, "missing", catalog, credentialStates{}); !errors.Is(err, ErrMigrationItemNotFound) {
		t.Fatalf("unknown item should report not found: %v", err)
	}
	if _, err := migration.MarkResolved(ctx, "mcp_server", "legacy-mcp"); err != nil {
		t.Fatal(err)
	}
	if _, err := migration.RetryMCP(ctx, "legacy-mcp", catalog, credentialStates{"cred-1": true}); !errors.Is(err, ErrMigrationItemSettled) {
		t.Fatalf("settled item should reject retry: %v", err)
	}
}

func TestRetrySkillRechecksDependencies(t *testing.T) {
	ctx := context.Background()
	migration, skills := openMigration(t, nil)
	source := writePackage(t, "user-source", "user-skill", "original")
	manifest := validManifest(Asset{
		OldID: "legacy-user", Name: "User Skill", Version: "1", LegacySource: "user",
		Enabled: true, ContentPath: source, RequiredMCPServerIDs: []string{"private-mcp"},
	})
	first, err := migration.Migrate(ctx, manifest, readiness{status: NeedsReview, reason: "mcp_not_healthy:private-mcp"})
	if err != nil || first[0].Status != NeedsReview {
		t.Fatalf("unexpected migration: %#v, %v", first, err)
	}
	installed, err := skills.Get(ctx, first[0].TargetID)
	if err != nil || installed.Enabled {
		t.Fatalf("skill should be installed but disabled: %#v, %v", installed, err)
	}

	retried, err := migration.RetrySkill(ctx, "legacy-user", readiness{status: Ready})
	if err != nil || retried.Status != Ready {
		t.Fatalf("unexpected skill retry: %#v, %v", retried, err)
	}
	installed, err = skills.Get(ctx, first[0].TargetID)
	if err != nil || !installed.Enabled {
		t.Fatalf("recovered skill was not enabled: %#v, %v", installed, err)
	}
	if _, err := migration.RetrySkill(ctx, "legacy-user", readiness{status: Ready}); !errors.Is(err, ErrMigrationItemSettled) {
		t.Fatalf("settled item should reject retry: %v", err)
	}
	if _, err := migration.RetrySkill(ctx, "missing", nil); !errors.Is(err, ErrMigrationItemNotFound) {
		t.Fatalf("unknown item should report not found: %v", err)
	}
}
