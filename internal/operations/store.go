package operations

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"workagent3/internal/contracts"

	_ "modernc.org/sqlite"
)

type Store struct {
	db          *sql.DB
	releaseRoot string
}

type Activation struct {
	ID          int64                `json:"id"`
	Version     string               `json:"version"`
	Previous    map[Component]string `json:"previous"`
	State       string               `json:"state"`
	CreatedAt   time.Time            `json:"created_at"`
	CompletedAt *time.Time           `json:"completed_at,omitempty"`
}

type ReleaseStatus struct {
	Version    string          `json:"version"`
	State      string          `json:"state"`
	Manifest   ReleaseManifest `json:"manifest"`
	Installed  time.Time       `json:"installed_at"`
	NotifiedAt *time.Time      `json:"notified_at,omitempty"`
	Readiness  *Readiness      `json:"readiness,omitempty"`
}

func Open(databasePath, releaseRoot string) (*Store, error) {
	if !filepath.IsAbs(releaseRoot) {
		return nil, errors.New("release root must be absolute")
	}
	if err := os.MkdirAll(releaseRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create release root: %w", err)
	}
	if err := ensureNoReparseAncestors(releaseRoot); err != nil {
		return nil, fmt.Errorf("validate release root: %w", err)
	}
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return nil, fmt.Errorf("open operations database: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database, releaseRoot: filepath.Clean(releaseRoot)}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS releases (
  version TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('candidate','active','superseded')),
  installed_at INTEGER NOT NULL,
  notified_at INTEGER,
  readiness_json TEXT
);
CREATE TABLE IF NOT EXISTS active_components (
  component TEXT PRIMARY KEY,
  version TEXT NOT NULL REFERENCES releases(version),
  activated_at INTEGER NOT NULL,
  activation_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activation_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL REFERENCES releases(version),
  previous_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','committed','rolled_back')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);`)
	if err != nil {
		return fmt.Errorf("migrate operations database: %w", err)
	}
	return nil
}

func (s *Store) Install(ctx context.Context, sourceRoot string, manifest ReleaseManifest, installedAt time.Time) (ReleaseStatus, error) {
	if !filepath.IsAbs(sourceRoot) {
		return ReleaseStatus{}, errors.New("release source must be absolute")
	}
	if err := manifest.Validate(); err != nil {
		return ReleaseStatus{}, err
	}
	if err := verifyArtifacts(sourceRoot, manifest); err != nil {
		return ReleaseStatus{}, err
	}
	destination := filepath.Join(s.releaseRoot, manifest.Version)
	if _, err := os.Stat(destination); err == nil {
		installed, loadErr := ReadManifest(filepath.Join(destination, ManifestName))
		if loadErr != nil || !sameManifest(installed, manifest) {
			return ReleaseStatus{}, fmt.Errorf("immutable release %s already exists with different content", manifest.Version)
		}
		if err := verifyArtifacts(destination, installed); err != nil {
			return ReleaseStatus{}, err
		}
		if err := s.registerCandidate(ctx, manifest, installedAt); err != nil {
			return ReleaseStatus{}, err
		}
		status, err := s.Status(ctx, manifest.Version)
		if err != nil || !sameManifest(status.Manifest, manifest) {
			return ReleaseStatus{}, errors.New("installed release conflicts with its operations record")
		}
		return status, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return ReleaseStatus{}, err
	}
	staging, err := os.MkdirTemp(s.releaseRoot, ".install-"+manifest.Version+"-")
	if err != nil {
		return ReleaseStatus{}, err
	}
	removeStaging := true
	defer func() {
		if removeStaging {
			_ = os.RemoveAll(staging)
		}
	}()
	if err := copyArtifacts(sourceRoot, staging, manifest); err != nil {
		return ReleaseStatus{}, fmt.Errorf("copy release artifacts: %w", err)
	}
	if err := writeManifest(filepath.Join(staging, ManifestName), manifest); err != nil {
		return ReleaseStatus{}, err
	}
	if err := verifyArtifacts(staging, manifest); err != nil {
		return ReleaseStatus{}, err
	}
	if err := os.Rename(staging, destination); err != nil {
		return ReleaseStatus{}, fmt.Errorf("activate immutable release directory: %w", err)
	}
	removeStaging = false
	if err := s.registerCandidate(ctx, manifest, installedAt); err != nil {
		return ReleaseStatus{}, err
	}
	installedAt = installedAt.UTC()
	return ReleaseStatus{Version: manifest.Version, State: "candidate", Manifest: manifest, Installed: installedAt}, nil
}

func (s *Store) registerCandidate(ctx context.Context, manifest ReleaseManifest, installedAt time.Time) error {
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO releases(version,manifest_json,state,installed_at) VALUES(?,?,?,?)`,
		manifest.Version, string(manifestJSON), "candidate", installedAt.UTC().UnixMilli())
	if err != nil {
		return fmt.Errorf("register installed release: %w", err)
	}
	return nil
}

func (s *Store) PublishUpgrade(ctx context.Context, version string, publisher NotificationPublisher, publishedAt time.Time) (contracts.Notification, error) {
	status, err := s.Status(ctx, version)
	if err != nil {
		return contracts.Notification{}, err
	}
	notice, err := NoticeFor(status.Manifest.IncludedComponents)
	if err != nil {
		return contracts.Notification{}, err
	}
	publishedAt = publishedAt.UTC()
	notification, err := publisher.Publish(ctx, contracts.NotificationInput{
		TargetSID: "*", Kind: "upgrade", Title: "系统升级通知", Message: notice.Message,
	})
	if err != nil {
		return contracts.Notification{}, fmt.Errorf("publish upgrade notification: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `UPDATE releases SET notified_at=? WHERE version=?`, publishedAt.UnixMilli(), version)
	if err != nil {
		return contracts.Notification{}, fmt.Errorf("record upgrade notification: %w", err)
	}
	return notification, nil
}

func (s *Store) RecordReadiness(ctx context.Context, version string, readiness Readiness) error {
	if _, err := s.Status(ctx, version); err != nil {
		return err
	}
	if err := verifyReadiness(readiness); err != nil {
		return err
	}
	readiness.CheckedAt = readiness.CheckedAt.UTC()
	payload, err := json.Marshal(readiness)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE releases SET readiness_json=? WHERE version=?`, string(payload), version)
	if err != nil {
		return fmt.Errorf("record release readiness: %w", err)
	}
	return nil
}

func (s *Store) Activate(ctx context.Context, version string, now time.Time) (Activation, error) {
	status, err := s.Status(ctx, version)
	if err != nil {
		return Activation{}, err
	}
	now = now.UTC()
	if status.NotifiedAt == nil || now.Sub(*status.NotifiedAt) < MinimumNotificationAge {
		return Activation{}, errors.New("upgrade notification must be published at least 60 seconds before activation")
	}
	if status.Readiness == nil || status.Readiness.CheckedAt.Before(*status.NotifiedAt) || status.Readiness.CheckedAt.After(now) {
		return Activation{}, errors.New("fresh post-notification readiness evidence is required")
	}
	if err := verifyReadiness(*status.Readiness); err != nil {
		return Activation{}, err
	}
	releasePath := filepath.Join(s.releaseRoot, status.Version)
	if err := verifyArtifacts(releasePath, status.Manifest); err != nil {
		return Activation{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Activation{}, err
	}
	defer tx.Rollback()
	previous := make(map[Component]string, len(status.Manifest.IncludedComponents))
	for _, component := range status.Manifest.IncludedComponents {
		var old string
		err := tx.QueryRowContext(ctx, `SELECT version FROM active_components WHERE component=?`, component).Scan(&old)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return Activation{}, err
		}
		previous[component] = old
	}
	previousJSON, err := json.Marshal(previous)
	if err != nil {
		return Activation{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO activation_journal(version,previous_json,state,created_at) VALUES(?,?,?,?)`,
		version, string(previousJSON), "prepared", now.UnixMilli())
	if err != nil {
		return Activation{}, fmt.Errorf("prepare activation journal: %w", err)
	}
	activationID, err := result.LastInsertId()
	if err != nil {
		return Activation{}, err
	}
	for _, component := range status.Manifest.IncludedComponents {
		_, err := tx.ExecContext(ctx, `INSERT INTO active_components(component,version,activated_at,activation_id) VALUES(?,?,?,?)
ON CONFLICT(component) DO UPDATE SET version=excluded.version,activated_at=excluded.activated_at,activation_id=excluded.activation_id`,
			component, version, now.UnixMilli(), activationID)
		if err != nil {
			return Activation{}, fmt.Errorf("activate component %s: %w", component, err)
		}
	}
	if err := refreshReleaseStates(ctx, tx); err != nil {
		return Activation{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE activation_journal SET state='committed',completed_at=? WHERE id=?`, now.UnixMilli(), activationID); err != nil {
		return Activation{}, err
	}
	if err := tx.Commit(); err != nil {
		return Activation{}, err
	}
	completed := now
	return Activation{ID: activationID, Version: version, Previous: previous, State: "committed", CreatedAt: now, CompletedAt: &completed}, nil
}

func (s *Store) Rollback(ctx context.Context, activationID int64, now time.Time) (Activation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Activation{}, err
	}
	defer tx.Rollback()
	var activation Activation
	var previousJSON string
	var createdAt int64
	if err := tx.QueryRowContext(ctx, `SELECT version,previous_json,state,created_at FROM activation_journal WHERE id=?`, activationID).
		Scan(&activation.Version, &previousJSON, &activation.State, &createdAt); err != nil {
		return Activation{}, fmt.Errorf("load activation journal: %w", err)
	}
	if activation.State != "committed" {
		return Activation{}, errors.New("only a committed activation can be rolled back")
	}
	if err := json.Unmarshal([]byte(previousJSON), &activation.Previous); err != nil {
		return Activation{}, fmt.Errorf("decode activation journal: %w", err)
	}
	components := make([]Component, 0, len(activation.Previous))
	for component := range activation.Previous {
		components = append(components, component)
	}
	components = sortedComponents(components)
	for _, component := range components {
		var current string
		if err := tx.QueryRowContext(ctx, `SELECT version FROM active_components WHERE component=?`, component).Scan(&current); err != nil || current != activation.Version {
			return Activation{}, fmt.Errorf("component %s changed after activation; refusing stale rollback", component)
		}
		previous := activation.Previous[component]
		if previous == "" {
			if _, err := tx.ExecContext(ctx, `DELETE FROM active_components WHERE component=?`, component); err != nil {
				return Activation{}, err
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE active_components SET version=?,activated_at=?,activation_id=? WHERE component=?`,
			previous, now.UTC().UnixMilli(), activationID, component); err != nil {
			return Activation{}, err
		}
	}
	now = now.UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE activation_journal SET state='rolled_back',completed_at=? WHERE id=?`, now.UnixMilli(), activationID); err != nil {
		return Activation{}, err
	}
	if err := refreshReleaseStates(ctx, tx); err != nil {
		return Activation{}, err
	}
	if err := tx.Commit(); err != nil {
		return Activation{}, err
	}
	activation.ID = activationID
	activation.State = "rolled_back"
	activation.CreatedAt = time.UnixMilli(createdAt).UTC()
	activation.CompletedAt = &now
	return activation, nil
}

func (s *Store) Active(ctx context.Context) (map[Component]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT component,version FROM active_components ORDER BY component`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	active := make(map[Component]string)
	for rows.Next() {
		var component Component
		var version string
		if err := rows.Scan(&component, &version); err != nil {
			return nil, err
		}
		active[component] = version
	}
	return active, rows.Err()
}

func (s *Store) Status(ctx context.Context, version string) (ReleaseStatus, error) {
	var result ReleaseStatus
	var manifestJSON string
	var installedAt int64
	var notifiedAt sql.NullInt64
	var readinessJSON sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT version,state,manifest_json,installed_at,notified_at,readiness_json FROM releases WHERE version=?`, version).
		Scan(&result.Version, &result.State, &manifestJSON, &installedAt, &notifiedAt, &readinessJSON)
	if err != nil {
		return ReleaseStatus{}, fmt.Errorf("load release status: %w", err)
	}
	if err := json.Unmarshal([]byte(manifestJSON), &result.Manifest); err != nil {
		return ReleaseStatus{}, fmt.Errorf("decode stored release manifest: %w", err)
	}
	result.Installed = time.UnixMilli(installedAt).UTC()
	if notifiedAt.Valid {
		value := time.UnixMilli(notifiedAt.Int64).UTC()
		result.NotifiedAt = &value
	}
	if readinessJSON.Valid {
		var readiness Readiness
		if err := json.Unmarshal([]byte(readinessJSON.String), &readiness); err != nil {
			return ReleaseStatus{}, fmt.Errorf("decode stored readiness: %w", err)
		}
		result.Readiness = &readiness
	}
	return result, nil
}

func sameManifest(left, right ReleaseManifest) bool {
	left.IncludedComponents = sortedComponents(left.IncludedComponents)
	right.IncludedComponents = sortedComponents(right.IncludedComponents)
	sort.Slice(left.Artifacts, func(i, j int) bool { return left.Artifacts[i].Component < left.Artifacts[j].Component })
	sort.Slice(right.Artifacts, func(i, j int) bool { return right.Artifacts[i].Component < right.Artifacts[j].Component })
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}

func refreshReleaseStates(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `UPDATE releases SET state='superseded'
WHERE state='active' AND version NOT IN (SELECT DISTINCT version FROM active_components)`); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE releases SET state='active'
WHERE version IN (SELECT DISTINCT version FROM active_components)`)
	return err
}

func validateEvidenceLabel(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= 256 && !strings.ContainsAny(value, "\r\n\x00")
}
