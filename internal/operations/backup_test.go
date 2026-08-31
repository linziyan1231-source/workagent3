package operations

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"workagent3/internal/sqlitebackup"
	portalstore "workagent3/internal/store"

	_ "modernc.org/sqlite"
)

func TestBackupSanitizesPortalCredentialsAndRestoresOwnersToIsolation(t *testing.T) {
	root := t.TempDir()
	portalPath := filepath.Join(root, "portal.db")
	createPortalBackupSource(t, portalPath)
	presetPath := filepath.Join(root, "preset.db")
	createSimpleDatabase(t, presetPath, "presets", "preset-one")
	backupRoot := filepath.Join(root, "backups")
	now := time.Date(2026, 8, 31, 3, 0, 0, 0, time.UTC)
	manifest, backupPath, err := CreateBackup(t.Context(), backupRoot, "3.0.0", []BackupSource{
		{Owner: OwnerPortalAuth, Exporter: backupFileExporter{path: portalPath, portal: true}},
		{Owner: OwnerPreset, TargetSID: "S-1-5-21-1000", Exporter: backupFileExporter{path: presetPath}},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Entries) != 2 || len(manifest.Excluded) != len(defaultBackupExclusions) {
		t.Fatalf("unexpected backup manifest: %#v", manifest)
	}
	portalSnapshot := filepath.Join(backupPath, manifest.Entries[0].File)
	snapshot, err := sql.Open("sqlite", portalSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	var username string
	if err := snapshot.QueryRow(`SELECT username FROM users`).Scan(&username); err != nil || username != "alice" {
		t.Fatalf("sanitized user snapshot missing: %q %v", username, err)
	}
	var admin int
	if err := snapshot.QueryRow(`SELECT admin FROM users WHERE username='alice'`).Scan(&admin); err != nil || admin != 0 {
		t.Fatalf("legacy backup did not receive the safe non-admin default: %d %v", admin, err)
	}
	for _, table := range []string{"sessions", "runtime_credentials"} {
		var exists int
		if err := snapshot.QueryRow(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)`, table).Scan(&exists); err != nil || exists != 0 {
			t.Fatalf("credential table %s leaked into backup", table)
		}
	}

	deniedRoot := filepath.Join(root, "denied-restore")
	if _, err := RestoreBackup(backupPath, deniedRoot, "3.0.0", []string{"S-1-5-21-2000"}, now.Add(time.Hour)); err == nil {
		t.Fatal("restore accepted a SID outside its allow-list")
	}
	journalPayload, err := os.ReadFile(filepath.Join(deniedRoot, manifest.BackupID, "restore-journal.json"))
	if err != nil {
		t.Fatal(err)
	}
	var deniedJournal RestoreJournal
	if err := json.Unmarshal(journalPayload, &deniedJournal); err != nil || deniedJournal.State != "failed" || deniedJournal.FailureCode != "sid_not_allowed" {
		t.Fatalf("failed restore was not diagnosable: %#v %v", deniedJournal, err)
	}

	restored, err := RestoreBackup(backupPath, filepath.Join(root, "isolated-restore"), "3.0.0", []string{"S-1-5-21-1000"}, now.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if restored.Journal.State != "complete" {
		t.Fatalf("restore did not complete: %#v", restored.Journal)
	}
	for _, entry := range restored.Manifest.Entries {
		if _, err := os.Stat(filepath.Join(restored.Path, "data", entry.File)); err != nil {
			t.Fatalf("restored owner artifact missing: %s: %v", entry.Owner, err)
		}
	}
}

func TestRestoreRejectsTamperingAndVersionMismatch(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "audit.db")
	createSimpleDatabase(t, source, "events", "event-one")
	manifest, backupPath, err := CreateBackup(t.Context(), filepath.Join(root, "backups"), "4.0.0", []BackupSource{{Owner: OwnerAudit, Exporter: backupFileExporter{path: source}}}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreBackup(backupPath, filepath.Join(root, "wrong-version"), "4.1.0", nil, time.Now()); err == nil {
		t.Fatal("version-incompatible backup restored")
	}
	if err := os.WriteFile(filepath.Join(backupPath, manifest.Entries[0].File), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreBackup(backupPath, filepath.Join(root, "tampered-restore"), "4.0.0", nil, time.Now()); err == nil {
		t.Fatal("tampered backup restored")
	}
}

func TestBackupRejectsCredentialOwnerAndInvalidSID(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "source.db")
	createSimpleDatabase(t, database, "data", "value")
	for _, source := range []BackupSource{
		{Owner: "credential-broker", Exporter: backupFileExporter{path: database}},
		{Owner: OwnerMCP, TargetSID: "alice", Exporter: backupFileExporter{path: database}},
	} {
		if _, _, err := CreateBackup(t.Context(), filepath.Join(root, "backups"), "1.0.0", []BackupSource{source}, time.Now()); err == nil {
			t.Fatalf("unsafe backup source was accepted: %#v", source)
		}
	}
}

type backupFileExporter struct {
	path   string
	portal bool
}

func (exporter backupFileExporter) ExportBackup(ctx context.Context, destination string) error {
	if exporter.portal {
		return portalstore.ExportBackup(ctx, exporter.path, destination)
	}
	return sqlitebackup.Snapshot(ctx, exporter.path, destination)
}

func createPortalBackupSource(t *testing.T, path string) {
	t.Helper()
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	_, err = database.Exec(`
CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,sid TEXT,password_hash TEXT,disabled INTEGER,collaboration_enabled INTEGER);
CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires_at INTEGER);
CREATE TABLE runtime_credentials(sid TEXT PRIMARY KEY,credential_digest BLOB);
INSERT INTO users VALUES(1,'alice','Alice','S-1-5-21-1000','password-hash',0,1);
INSERT INTO sessions VALUES('plaintext-session-token',1,9999999999);
INSERT INTO runtime_credentials VALUES('S-1-5-21-1000',x'0102');`)
	if err != nil {
		t.Fatal(err)
	}
}

func createSimpleDatabase(t *testing.T, path, table, value string) {
	t.Helper()
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec(`CREATE TABLE `+table+` (value TEXT); INSERT INTO `+table+` VALUES(?)`, value); err != nil {
		t.Fatal(err)
	}
}
