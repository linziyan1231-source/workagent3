package skillmigration

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/skillruntime"
)

type readiness struct {
	status Status
	reason string
}

func (r readiness) MigrationStatus(context.Context, []string) (Status, string) {
	return r.status, r.reason
}

func TestMigrationIsRecoverableAcrossMCPAuthorization(t *testing.T) {
	ctx := context.Background()
	migration, skills := openMigration(t, nil)
	source := writePackage(t, "user-source", "user-skill", "original")
	manifest := validManifest(Asset{
		OldID: "legacy-user", Name: "User Skill", Description: "Migrated", Version: "1", LegacySource: "user",
		Enabled: true, ContentPath: source, RequiredMCPServerIDs: []string{"private-mcp"}, BindingObjectIDs: []string{"assistant-1"},
	})

	first, err := migration.Migrate(ctx, manifest, readiness{status: NeedsAuth, reason: "mcp_token_expired"})
	if err != nil || len(first) != 1 || first[0].Status != NeedsAuth {
		t.Fatalf("unexpected first migration: %#v, %v", first, err)
	}
	installed, err := skills.Get(ctx, first[0].TargetID)
	if err != nil || installed.Enabled {
		t.Fatalf("skill should be installed but disabled: %#v, %v", installed, err)
	}

	second, err := migration.Migrate(ctx, manifest, readiness{status: Ready})
	if err != nil || second[0].Status != Ready || second[0].TargetID != first[0].TargetID {
		t.Fatalf("migration did not resume in place: %#v, %v", second, err)
	}
	installed, err = skills.Get(ctx, second[0].TargetID)
	if err != nil || !installed.Enabled {
		t.Fatalf("recovered skill was not enabled: %#v, %v", installed, err)
	}
	if contents, err := os.ReadFile(filepath.Join(source, "SKILL.md")); err != nil || !strings.Contains(string(contents), "original") {
		t.Fatalf("legacy package was modified: %q, %v", contents, err)
	}
}

func TestBuiltinUsesReleasedPackageAndPreservesDisabledState(t *testing.T) {
	release := writePackage(t, "release", "pdf", "released")
	legacy := writePackage(t, "legacy", "pdf", "legacy")
	migration, skills := openMigration(t, map[string]string{"pdf": release})
	results, err := migration.Migrate(context.Background(), validManifest(Asset{
		OldID: "builtin-pdf", Name: "PDF", Version: "2", LegacySource: "builtin", Enabled: false, ContentPath: legacy,
	}), nil)
	if err != nil || results[0].Status != Ready {
		t.Fatalf("builtin migration failed: %#v, %v", results, err)
	}
	entry, err := skills.Get(context.Background(), results[0].TargetID)
	if err != nil || entry.Enabled || entry.Source != "builtin" {
		t.Fatalf("unexpected builtin entry: %#v, %v", entry, err)
	}
	contents, err := os.ReadFile(filepath.Join(skills.RootFor(entry), "pdf", "SKILL.md"))
	if err != nil || !strings.Contains(string(contents), "released") || strings.Contains(string(contents), "legacy") {
		t.Fatalf("legacy builtin replaced released asset: %q, %v", contents, err)
	}
}

func TestMigrationRecordsReviewFailureDeletionAndCollision(t *testing.T) {
	ctx := context.Background()
	migration, skills := openMigration(t, nil)
	occupied := writePackage(t, "occupied", "occupied", "occupied")
	_, err := skills.Install(ctx, skillruntime.InstallInput{
		Entry: skillruntime.Entry{ID: "collision", Name: "Occupied", Version: "1", Source: "user", Enabled: true}, SourceDirectory: occupied,
	})
	if err != nil {
		t.Fatal(err)
	}
	migration.newID = func() (string, error) { return "migrated-collision", nil }
	userSource := writePackage(t, "collision-source", "replacement", "replacement")
	results, err := migration.Migrate(ctx, Manifest{
		SchemaVersion: 1, SID: "S-1-5-21-1", CapturedAt: time.Now(),
		Skills: []Asset{
			{OldID: "collision", Name: "Replacement", Version: "1", LegacySource: "user", Enabled: true, ContentPath: userSource},
			{OldID: "extension-one", Name: "Extension", Version: "1", LegacySource: "extension", Enabled: true, ContentPath: userSource},
			{OldID: "deleted-one", Name: "Deleted", Version: "1", LegacySource: "user", Deleted: true, ContentPath: userSource},
			{OldID: "bad-path", Name: "Bad", Version: "1", LegacySource: "user", Enabled: true, ContentPath: "relative"},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if results[0].TargetID != "migrated-collision" || results[0].Status != Ready {
		t.Fatalf("collision mapping failed: %#v", results[0])
	}
	if results[1].Status != NeedsReview || results[2].Status != Ready || results[2].Reason != "source_deleted" || results[3].Status != Failed {
		t.Fatalf("unexpected terminal states: %#v", results)
	}
	journal, err := migration.Results(ctx)
	if err != nil || len(journal) != 4 {
		t.Fatalf("unexpected journal: %#v, %v", journal, err)
	}
}

func TestInterruptedJournalRequiresRetry(t *testing.T) {
	migration, _ := openMigration(t, nil)
	_, err := migration.db.Exec(`INSERT INTO skill_migrations(source_id,target_id,source_path,desired_enabled,deleted,status,reason,updated_at) VALUES('old','new','C:\\old',1,0,'running','',1)`)
	if err != nil {
		t.Fatal(err)
	}
	results, err := migration.Results(context.Background())
	if err != nil || len(results) != 1 || results[0].Status != NeedsReview || results[0].Reason != "migration_interrupted_retry_required" {
		t.Fatalf("unexpected interrupted journal: %#v, %v", results, err)
	}
}

func openMigration(t *testing.T, releases map[string]string) (*Store, *skillruntime.Store) {
	t.Helper()
	root := t.TempDir()
	skills, err := skillruntime.Open(filepath.Join(root, "skills.db"), filepath.Join(root, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = skills.Close() })
	migration, err := Open(filepath.Join(root, "migration.db"), skills, releases)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = migration.Close() })
	return migration, skills
}

func validManifest(asset Asset) Manifest {
	return Manifest{SchemaVersion: 1, SID: "S-1-5-21-1", CapturedAt: time.Now(), Skills: []Asset{asset}}
}

func writePackage(t *testing.T, directory, name, marker string) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), directory)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: " + name + "\ndescription: Test skill\n---\n" + marker
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}
