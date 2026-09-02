package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
)

func createSourceDB(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE payload(id INTEGER PRIMARY KEY); INSERT INTO payload VALUES (1)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
}

func auditActions(t *testing.T, auditPath string) map[string][]string {
	t.Helper()
	store, err := audit.Open(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	events, err := store.List(context.Background(), contracts.AuditQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	results := make(map[string][]string)
	for _, event := range events {
		if event.Actor != "backup-manager" {
			t.Fatalf("unexpected audit actor %q", event.Actor)
		}
		results[event.Action] = append(results[event.Action], event.Result)
	}
	return results
}

func requireTerminalEvent(t *testing.T, results map[string][]string, action, result string) {
	t.Helper()
	for _, recorded := range results[action] {
		if recorded == result {
			return
		}
	}
	t.Fatalf("no terminal %s event with result %s in %v", action, result, results)
}

func TestBackupCreateRecordsTerminalAuditEvents(t *testing.T) {
	root := t.TempDir()
	auditPath := filepath.Join(root, "audit.db")
	source := filepath.Join(root, "portal.db")
	createSourceDB(t, source)
	if err := run([]string{"-action", "create", "-version", "3.0.0-test",
		"-backup-root", filepath.Join(root, "backups"), "-audit-db", auditPath,
		"-source", "quota=" + source}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-action", "create", "-version", "3.0.0-test",
		"-backup-root", filepath.Join(root, "backups"), "-audit-db", auditPath,
		"-source", "quota=" + filepath.Join(root, "missing.db")}); err == nil {
		t.Fatal("create with a missing source succeeded")
	}
	results := auditActions(t, auditPath)
	requireTerminalEvent(t, results, audit.ActionBackupCreate, "success")
	requireTerminalEvent(t, results, audit.ActionBackupCreate, "failure")
}

func TestBackupRestoreRecordsTerminalAuditEvents(t *testing.T) {
	root := t.TempDir()
	auditPath := filepath.Join(root, "audit.db")
	source := filepath.Join(root, "portal.db")
	createSourceDB(t, source)
	backupRoot := filepath.Join(root, "backups")
	if err := run([]string{"-action", "create", "-version", "3.0.0-test",
		"-backup-root", backupRoot, "-audit-db", auditPath,
		"-source", "quota=" + source}); err != nil {
		t.Fatal(err)
	}
	entries, err := filepath.Glob(filepath.Join(backupRoot, "backup-*"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("backup not created: %v %v", entries, err)
	}
	if err := run([]string{"-action", "restore", "-version", "3.0.0-test",
		"-backup", entries[0], "-restore-root", filepath.Join(root, "restores"),
		"-audit-db", auditPath}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-action", "restore", "-version", "9.9.9",
		"-backup", entries[0], "-restore-root", filepath.Join(root, "restores"),
		"-audit-db", auditPath}); err == nil {
		t.Fatal("restore with an incompatible version succeeded")
	}
	results := auditActions(t, auditPath)
	requireTerminalEvent(t, results, audit.ActionBackupRestore, "success")
	requireTerminalEvent(t, results, audit.ActionBackupRestore, "failure")
}

func TestAuditDatabasePathMustBeExplicitAndAbsolute(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "portal.db")
	createSourceDB(t, source)
	err := run([]string{"-action", "create", "-version", "3.0.0-test",
		"-backup-root", filepath.Join(root, "backups"),
		"-source", "quota=" + source})
	if err == nil || !strings.Contains(err.Error(), "-audit-db") {
		t.Fatalf("missing audit path was accepted: %v", err)
	}
	err = run([]string{"-action", "create", "-version", "3.0.0-test",
		"-backup-root", filepath.Join(root, "backups"), "-audit-db", filepath.Join("data", "audit.db"),
		"-source", "quota=" + source})
	if err == nil || !strings.Contains(err.Error(), "-audit-db") {
		t.Fatalf("relative audit path was accepted: %v", err)
	}
}
