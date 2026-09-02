package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/operations"
	"workagent3/internal/sqlitebackup"
	portalstore "workagent3/internal/store"
)

type repeatedFlag []string

func (values *repeatedFlag) String() string { return strings.Join(*values, ",") }
func (values *repeatedFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) (err error) {
	flags := flag.NewFlagSet("backup-manager", flag.ContinueOnError)
	action := flags.String("action", "create", "create or restore")
	backupRoot := flags.String("backup-root", filepath.Join("data", "backups"), "Restricted backup root")
	restoreRoot := flags.String("restore-root", filepath.Join("data", "restore-jobs"), "Isolated restore root")
	backupPath := flags.String("backup", "", "Backup directory for restore")
	version := flags.String("version", "", "Application version compatibility boundary")
	auditPath := flags.String("audit-db", "", "Absolute audit SQLite path (the server's data/audit.db)")
	var sourceFlags repeatedFlag
	var allowedSIDFlags repeatedFlag
	flags.Var(&sourceFlags, "source", "Backup source owner[@SID]=absolute SQLite path; repeat for each owner")
	flags.Var(&allowedSIDFlags, "allow-sid", "SID permitted in the isolated restore; repeat as needed")
	if err := flags.Parse(args); err != nil {
		return err
	}
	// The audit path must be explicit and absolute: the previous relative
	// default (data/audit.db) resolved against the caller's working directory,
	// so server runs from another directory recorded nothing (or wrote a stray
	// database) and the real audit trail never saw backup.* events.
	if !filepath.IsAbs(*auditPath) {
		return errors.New("absolute -audit-db is required (the server's audit database, e.g. E:\\WorkAgent3\\data\\audit.db)")
	}
	// Audit must never block a backup or restore; an unavailable audit
	// database is reported on stderr and recording is skipped.
	auditStore, auditErr := audit.Open(*auditPath)
	if auditErr != nil {
		fmt.Fprintf(os.Stderr, "audit unavailable: %v\n", auditErr)
	} else {
		defer auditStore.Close()
	}
	defer func() {
		auditAction, ok := map[string]string{"create": audit.ActionBackupCreate, "restore": audit.ActionBackupRestore}[*action]
		if !ok || auditStore == nil {
			return
		}
		target := *backupRoot
		if *action == "restore" {
			target = *backupPath
		}
		audit.RecordCLI(context.Background(), auditStore, "backup-manager", auditAction, target, err, map[string]string{"version": *version})
	}()
	if *version == "" {
		return errors.New("-version is required")
	}
	now := time.Now().UTC()
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	switch *action {
	case "create":
		root, err := filepath.Abs(*backupRoot)
		if err != nil {
			return err
		}
		sources, err := parseSources(sourceFlags)
		if err != nil {
			return err
		}
		manifest, path, err := operations.CreateBackup(context.Background(), root, *version, sources, now)
		if err != nil {
			return err
		}
		return encoder.Encode(struct {
			Path     string                    `json:"path"`
			Manifest operations.BackupManifest `json:"manifest"`
		}{Path: path, Manifest: manifest})
	case "restore":
		if *backupPath == "" {
			return errors.New("restore requires -backup")
		}
		backup, err := filepath.Abs(*backupPath)
		if err != nil {
			return err
		}
		root, err := filepath.Abs(*restoreRoot)
		if err != nil {
			return err
		}
		restored, err := operations.RestoreBackup(backup, root, *version, allowedSIDFlags, now)
		if err != nil {
			return err
		}
		return encoder.Encode(restored)
	default:
		return fmt.Errorf("unknown action %q", *action)
	}
}

func parseSources(values []string) ([]operations.BackupSource, error) {
	sources := make([]operations.BackupSource, 0, len(values))
	for _, value := range values {
		parts := strings.SplitN(value, "=", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, fmt.Errorf("invalid backup source %q", value)
		}
		ownerAndSID := strings.SplitN(parts[0], "@", 2)
		source := operations.BackupSource{Owner: operations.DataOwner(ownerAndSID[0])}
		if len(ownerAndSID) == 2 {
			source.TargetSID = ownerAndSID[1]
		}
		path, err := filepath.Abs(parts[1])
		if err != nil {
			return nil, err
		}
		source.Exporter = fileExporter{path: path, portal: source.Owner == operations.OwnerPortalAuth}
		sources = append(sources, source)
	}
	return sources, nil
}

type fileExporter struct {
	path   string
	portal bool
}

func (exporter fileExporter) ExportBackup(ctx context.Context, destination string) error {
	if exporter.portal {
		return portalstore.ExportBackup(ctx, exporter.path, destination)
	}
	return sqlitebackup.Snapshot(ctx, exporter.path, destination)
}
