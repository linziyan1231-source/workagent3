package operations

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const BackupManifestName = "backup-manifest.json"

type DataOwner string

const (
	OwnerPortalAuth    DataOwner = "portal-auth"
	OwnerCollaboration DataOwner = "collaboration"
	OwnerQuota         DataOwner = "quota"
	OwnerSkillMarket   DataOwner = "skill-market"
	OwnerNotifications DataOwner = "notifications"
	OwnerAudit         DataOwner = "audit"
	OwnerSettings      DataOwner = "settings"
	OwnerModelAccess   DataOwner = "model-access"
	OwnerPreset        DataOwner = "preset"
	OwnerAutomation    DataOwner = "automation"
	OwnerSkill         DataOwner = "skill"
	OwnerMCP           DataOwner = "mcp"
)

var globalOwners = map[DataOwner]struct{}{
	OwnerPortalAuth: {}, OwnerCollaboration: {}, OwnerQuota: {}, OwnerSkillMarket: {},
	OwnerNotifications: {}, OwnerAudit: {}, OwnerSettings: {}, OwnerModelAccess: {},
}

var sidOwners = map[DataOwner]struct{}{
	OwnerPreset: {}, OwnerAutomation: {}, OwnerSkill: {}, OwnerMCP: {},
}

var defaultBackupExclusions = []string{
	"session_tokens", "runtime_registration_credentials", "plaintext_credentials",
	"native_codex_auth", "native_kimi_auth", "conversation_bodies", "prompts", "workspace_files",
}

type BackupSource struct {
	Owner     DataOwner
	TargetSID string
	Exporter  BackupExporter
}

type BackupExporter interface {
	ExportBackup(context.Context, string) error
}

type BackupEntry struct {
	Owner     DataOwner `json:"owner"`
	TargetSID string    `json:"target_sid,omitempty"`
	File      string    `json:"file"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
}

type BackupManifest struct {
	FormatVersion      int           `json:"format_version"`
	BackupID           string        `json:"backup_id"`
	ApplicationVersion string        `json:"application_version"`
	CreatedAt          time.Time     `json:"created_at"`
	Entries            []BackupEntry `json:"entries"`
	Excluded           []string      `json:"excluded"`
}

type RestoreJournal struct {
	FormatVersion int       `json:"format_version"`
	BackupID      string    `json:"backup_id"`
	State         string    `json:"state"`
	StartedAt     time.Time `json:"started_at"`
	CompletedAt   time.Time `json:"completed_at,omitempty"`
	FailureCode   string    `json:"failure_code,omitempty"`
}

type RestoredBackup struct {
	Path     string         `json:"path"`
	Journal  RestoreJournal `json:"journal"`
	Manifest BackupManifest `json:"manifest"`
}

func CreateBackup(ctx context.Context, backupRoot, applicationVersion string, sources []BackupSource, now time.Time) (BackupManifest, string, error) {
	if !filepath.IsAbs(backupRoot) || !validVersion(applicationVersion) {
		return BackupManifest{}, "", errors.New("absolute backup root and valid application version are required")
	}
	if len(sources) == 0 {
		return BackupManifest{}, "", errors.New("at least one backup source is required")
	}
	if err := os.MkdirAll(backupRoot, 0o700); err != nil {
		return BackupManifest{}, "", err
	}
	if err := ensureNoReparseAncestors(backupRoot); err != nil {
		return BackupManifest{}, "", err
	}
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return BackupManifest{}, "", err
	}
	now = now.UTC()
	backupID := "backup-" + now.Format("20060102T150405Z") + "-" + hex.EncodeToString(random)
	staging, err := os.MkdirTemp(backupRoot, ".backup-")
	if err != nil {
		return BackupManifest{}, "", err
	}
	removeStaging := true
	defer func() {
		if removeStaging {
			_ = os.RemoveAll(staging)
		}
	}()
	manifest := BackupManifest{
		FormatVersion: 1, BackupID: backupID, ApplicationVersion: applicationVersion,
		CreatedAt: now, Excluded: append([]string(nil), defaultBackupExclusions...),
	}
	seen := make(map[string]bool, len(sources))
	for index, source := range sources {
		if err := validateBackupSource(source); err != nil {
			return BackupManifest{}, "", err
		}
		key := string(source.Owner) + "\x00" + source.TargetSID
		if seen[key] {
			return BackupManifest{}, "", fmt.Errorf("duplicate backup source %s", source.Owner)
		}
		seen[key] = true
		file := fmt.Sprintf("%02d-%s.db", index+1, source.Owner)
		destination := filepath.Join(staging, file)
		err = source.Exporter.ExportBackup(ctx, destination)
		if err != nil {
			return BackupManifest{}, "", fmt.Errorf("snapshot %s owner: %w", source.Owner, err)
		}
		info, err := os.Stat(destination)
		if err != nil {
			return BackupManifest{}, "", err
		}
		digest, err := hashFile(destination)
		if err != nil {
			return BackupManifest{}, "", err
		}
		manifest.Entries = append(manifest.Entries, BackupEntry{
			Owner: source.Owner, TargetSID: source.TargetSID, File: file, Size: info.Size(), SHA256: digest,
		})
	}
	if err := writeBackupManifest(filepath.Join(staging, BackupManifestName), manifest); err != nil {
		return BackupManifest{}, "", err
	}
	destination := filepath.Join(backupRoot, backupID)
	if err := os.Rename(staging, destination); err != nil {
		return BackupManifest{}, "", fmt.Errorf("commit backup snapshot: %w", err)
	}
	removeStaging = false
	return manifest, destination, nil
}

func RestoreBackup(backupPath, restoreRoot, expectedApplicationVersion string, allowedSIDs []string, now time.Time) (RestoredBackup, error) {
	if !filepath.IsAbs(backupPath) || !filepath.IsAbs(restoreRoot) || !validVersion(expectedApplicationVersion) {
		return RestoredBackup{}, errors.New("absolute backup/restore roots and valid expected version are required")
	}
	manifest, err := readBackupManifest(filepath.Join(backupPath, BackupManifestName))
	if err != nil {
		return RestoredBackup{}, err
	}
	if manifest.ApplicationVersion != expectedApplicationVersion {
		return RestoredBackup{}, fmt.Errorf("backup version %s is incompatible with target version %s", manifest.ApplicationVersion, expectedApplicationVersion)
	}
	if err := ensureNoReparseAncestors(backupPath); err != nil {
		return RestoredBackup{}, err
	}
	allowed := make(map[string]bool, len(allowedSIDs))
	for _, sid := range allowedSIDs {
		if !validSID(sid) {
			return RestoredBackup{}, errors.New("restore allow-list contains an invalid SID")
		}
		allowed[sid] = true
	}
	if err := os.MkdirAll(restoreRoot, 0o700); err != nil {
		return RestoredBackup{}, err
	}
	if err := ensureNoReparseAncestors(restoreRoot); err != nil {
		return RestoredBackup{}, err
	}
	jobPath := filepath.Join(restoreRoot, manifest.BackupID)
	if _, err := os.Stat(jobPath); err == nil || !errors.Is(err, os.ErrNotExist) {
		return RestoredBackup{}, errors.New("restore job already exists; refusing to mix restore attempts")
	}
	if err := os.Mkdir(jobPath, 0o700); err != nil {
		return RestoredBackup{}, err
	}
	now = now.UTC()
	journal := RestoreJournal{FormatVersion: 1, BackupID: manifest.BackupID, State: "verifying", StartedAt: now}
	journalPath := filepath.Join(jobPath, "restore-journal.json")
	if err := writeRestoreJournal(journalPath, journal); err != nil {
		return RestoredBackup{}, err
	}
	fail := func(code string, cause error) (RestoredBackup, error) {
		journal.State = "failed"
		journal.FailureCode = code
		journal.CompletedAt = time.Now().UTC()
		_ = writeRestoreJournal(journalPath, journal)
		return RestoredBackup{}, cause
	}
	dataPath := filepath.Join(jobPath, "data")
	if err := os.Mkdir(dataPath, 0o700); err != nil {
		return fail("create_target", err)
	}
	for _, entry := range manifest.Entries {
		if entry.TargetSID != "" && !allowed[entry.TargetSID] {
			return fail("sid_not_allowed", fmt.Errorf("backup contains SID %s outside the restore allow-list", entry.TargetSID))
		}
		from := filepath.Join(backupPath, filepath.FromSlash(entry.File))
		if err := ensureRegularBeneath(backupPath, from); err != nil {
			return fail("invalid_artifact", err)
		}
		info, err := os.Stat(from)
		if err != nil || info.Size() != entry.Size {
			return fail("size_mismatch", errors.New("backup artifact size mismatch"))
		}
		digest, err := hashFile(from)
		if err != nil || !strings.EqualFold(digest, entry.SHA256) {
			return fail("integrity_mismatch", errors.New("backup artifact integrity mismatch"))
		}
		to := filepath.Join(dataPath, filepath.FromSlash(entry.File))
		if err := copyRegularFile(from, to); err != nil {
			return fail("copy_failed", err)
		}
	}
	journal.State = "complete"
	journal.CompletedAt = now
	if err := writeRestoreJournal(journalPath, journal); err != nil {
		return RestoredBackup{}, err
	}
	return RestoredBackup{Path: jobPath, Journal: journal, Manifest: manifest}, nil
}

func validateBackupSource(source BackupSource) error {
	if source.Exporter == nil {
		return errors.New("backup source exporter is required")
	}
	return validateBackupOwner(source.Owner, source.TargetSID)
}

func validateBackupOwner(owner DataOwner, targetSID string) error {
	if _, ok := globalOwners[owner]; ok {
		if targetSID != "" {
			return fmt.Errorf("global owner %s cannot have a target SID", owner)
		}
		return nil
	}
	if _, ok := sidOwners[owner]; ok {
		if !validSID(targetSID) {
			return fmt.Errorf("owner %s requires a valid target SID", owner)
		}
		return nil
	}
	return fmt.Errorf("unknown or credential-bearing backup owner %q", owner)
}

func ensureNoReparseAncestors(path string) error {
	current, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
			return errors.New("backup source path contains a reparse point")
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}

func readBackupManifest(path string) (BackupManifest, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return BackupManifest{}, fmt.Errorf("read backup manifest: %w", err)
	}
	var manifest BackupManifest
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return BackupManifest{}, fmt.Errorf("decode backup manifest: %w", err)
	}
	if manifest.FormatVersion != 1 || !validVersion(manifest.ApplicationVersion) || !validVersion(manifest.BackupID) || len(manifest.Entries) == 0 {
		return BackupManifest{}, errors.New("backup manifest metadata is invalid")
	}
	exclusions := make(map[string]bool, len(manifest.Excluded))
	for _, excluded := range manifest.Excluded {
		exclusions[excluded] = true
	}
	for _, required := range defaultBackupExclusions {
		if !exclusions[required] {
			return BackupManifest{}, fmt.Errorf("backup manifest does not exclude %s", required)
		}
	}
	seen := make(map[string]bool, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		if !validRelative(entry.File) || entry.Size < 0 || !validSHA256(entry.SHA256) {
			return BackupManifest{}, errors.New("backup manifest entry is invalid")
		}
		if err := validateBackupOwner(entry.Owner, entry.TargetSID); err != nil {
			return BackupManifest{}, err
		}
		key := string(entry.Owner) + "\x00" + entry.TargetSID
		if seen[key] {
			return BackupManifest{}, errors.New("backup manifest contains duplicate owner entries")
		}
		seen[key] = true
	}
	return manifest, nil
}

func writeBackupManifest(path string, manifest BackupManifest) error {
	payload, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o600)
}

func writeRestoreJournal(path string, journal RestoreJournal) error {
	payload, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o600)
}

func copyRegularFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func validSID(value string) bool {
	return strings.HasPrefix(value, "S-1-") && len(value) <= 184 && !strings.ContainsAny(value, "\\/\r\n\x00")
}

func sortedBackupEntries(entries []BackupEntry) []BackupEntry {
	result := append([]BackupEntry(nil), entries...)
	sort.Slice(result, func(i, j int) bool {
		if result[i].Owner == result[j].Owner {
			return result[i].TargetSID < result[j].TargetSID
		}
		return result[i].Owner < result[j].Owner
	})
	return result
}
