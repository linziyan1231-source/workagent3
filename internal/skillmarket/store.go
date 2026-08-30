package skillmarket

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"workagent3/internal/contracts"
)

var (
	ErrNotFound     = contracts.ErrSkillMarketEntryNotFound
	ErrForbidden    = contracts.ErrSkillMarketForbidden
	versionPattern  = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	marketIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

type Status string

const (
	Draft    Status = "draft"
	Approved Status = "approved"
	Rejected Status = "rejected"
)

type Entry struct {
	ID                   string
	Name                 string
	Description          string
	Version              string
	PublisherUsername    string
	PublisherDisplayName string
	ObjectKey            string
	ArchiveDigest        string
	ArchiveBytes         int64
	Status               Status
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type Store struct {
	db          *sql.DB
	archiveRoot string
	now         func() time.Time
}

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open skill market database: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database, archiveRoot: filepath.Join(filepath.Dir(path), "skill-market"), now: time.Now}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func OpenWithArchiveRoot(path, archiveRoot string) (*Store, error) {
	store, err := Open(path)
	if err != nil {
		return nil, err
	}
	root, err := filepath.Abs(archiveRoot)
	if err != nil {
		store.Close()
		return nil, err
	}
	store.archiveRoot = root
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS skill_market_entries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher_username TEXT NOT NULL,
  publisher_display_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  archive_digest TEXT NOT NULL,
  archive_bytes INTEGER NOT NULL CHECK (archive_bytes > 0),
  status TEXT NOT NULL CHECK (status IN ('draft','approved','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (publisher_username, name_normalized, version)
);
CREATE INDEX IF NOT EXISTS skill_market_status_updated ON skill_market_entries(status, updated_at DESC);`)
	if err != nil {
		return fmt.Errorf("migrate skill market database: %w", err)
	}
	return nil
}

func (s *Store) Publish(ctx context.Context, entry Entry) (Entry, error) {
	entry.Name = strings.TrimSpace(entry.Name)
	entry.Description = strings.TrimSpace(entry.Description)
	entry.Version = strings.TrimSpace(entry.Version)
	entry.PublisherUsername = strings.TrimSpace(entry.PublisherUsername)
	entry.PublisherDisplayName = strings.TrimSpace(entry.PublisherDisplayName)
	entry.ObjectKey = strings.TrimSpace(entry.ObjectKey)
	entry.ArchiveDigest = strings.ToLower(strings.TrimSpace(entry.ArchiveDigest))
	if entry.ID == "" || entry.Name == "" || len(entry.Name) > 240 || entry.Description == "" || len(entry.Description) > 4096 ||
		!versionPattern.MatchString(entry.Version) || entry.PublisherUsername == "" || entry.ObjectKey == "" ||
		entry.ArchiveDigest == "" || entry.ArchiveBytes <= 0 {
		return Entry{}, errors.New("invalid skill market entry")
	}
	stamp := s.now().UnixMilli()
	_, err := s.db.ExecContext(ctx, `INSERT INTO skill_market_entries
(id,name,name_normalized,description,version,publisher_username,publisher_display_name,object_key,archive_digest,archive_bytes,status,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?)`, entry.ID, entry.Name, strings.ToLower(entry.Name), entry.Description, entry.Version,
		entry.PublisherUsername, entry.PublisherDisplayName, entry.ObjectKey, entry.ArchiveDigest, entry.ArchiveBytes, Draft, stamp, stamp)
	if err != nil {
		return Entry{}, fmt.Errorf("publish skill market entry: %w", err)
	}
	return s.ByID(ctx, entry.ID)
}

func (s *Store) Review(ctx context.Context, id string, status Status) (Entry, error) {
	if status != Approved && status != Rejected {
		return Entry{}, errors.New("review status must be approved or rejected")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE skill_market_entries SET status=?,updated_at=? WHERE id=?`, status, s.now().UnixMilli(), id)
	if err != nil {
		return Entry{}, fmt.Errorf("review skill market entry: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Entry{}, ErrNotFound
	}
	return s.ByID(ctx, id)
}

func (s *Store) ByID(ctx context.Context, id string) (Entry, error) {
	return scanEntry(s.db.QueryRowContext(ctx, marketSelect+` WHERE id=?`, id))
}

func (s *Store) ListApproved(ctx context.Context, viewerUsername string) ([]contracts.SkillMarketEntry, error) {
	rows, err := s.db.QueryContext(ctx, marketSelect+` WHERE status=? ORDER BY updated_at DESC,id`, Approved)
	if err != nil {
		return nil, fmt.Errorf("list approved skill market entries: %w", err)
	}
	defer rows.Close()
	entries := make([]contracts.SkillMarketEntry, 0)
	for rows.Next() {
		entry, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		entries = append(entries, contracts.SkillMarketEntry{
			ID: entry.ID, Name: entry.Name, Description: entry.Description, Version: entry.Version,
			Publisher: contracts.Publisher{Username: entry.PublisherUsername, DisplayName: entry.PublisherDisplayName},
			UpdatedAt: entry.UpdatedAt.UTC(), ArchiveBytes: entry.ArchiveBytes,
			CanDelete: strings.EqualFold(entry.PublisherUsername, viewerUsername),
		})
	}
	return entries, rows.Err()
}

func (s *Store) Delete(ctx context.Context, id, actorUsername string, admin bool) error {
	entry, err := s.ByID(ctx, id)
	if err != nil {
		return err
	}
	if !admin && !strings.EqualFold(entry.PublisherUsername, actorUsername) {
		return ErrForbidden
	}
	archivePath, pathErr := s.resolveArchivePath(entry.ObjectKey)
	archiveTrash := ""
	if pathErr == nil {
		if info, statErr := os.Lstat(archivePath); statErr == nil {
			if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return errors.New("skill market archive is not a regular file")
			}
			trashRoot := filepath.Join(s.archiveRoot, ".trash")
			if err := os.MkdirAll(trashRoot, 0o700); err != nil {
				return err
			}
			archiveTrash = filepath.Join(trashRoot, safeMarketFile(entry.ID)+"-"+fmt.Sprint(s.now().UTC().UnixMilli())+".zip")
			if err := os.Rename(archivePath, archiveTrash); err != nil {
				return err
			}
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return statErr
		}
	} else if !errors.Is(pathErr, os.ErrNotExist) {
		return pathErr
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM skill_market_entries WHERE id=?`, id)
	if err != nil && archiveTrash != "" {
		_ = os.Rename(archiveTrash, archivePath)
	}
	return err
}

func (s *Store) ApprovedPackage(ctx context.Context, id string) (contracts.SkillMarketPackage, error) {
	entry, err := s.ByID(ctx, id)
	if err != nil {
		return contracts.SkillMarketPackage{}, err
	}
	if entry.Status != Approved {
		return contracts.SkillMarketPackage{}, ErrNotFound
	}
	if entry.ArchiveBytes <= 0 || entry.ArchiveBytes > 50<<20 {
		return contracts.SkillMarketPackage{}, errors.New("skill market archive exceeds installation limit")
	}
	resolvedArchive, err := s.resolveArchivePath(entry.ObjectKey)
	if err != nil {
		return contracts.SkillMarketPackage{}, errors.New("skill market archive is unavailable")
	}
	info, err := os.Lstat(resolvedArchive)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != entry.ArchiveBytes {
		return contracts.SkillMarketPackage{}, errors.New("skill market archive is unavailable")
	}
	file, err := os.Open(resolvedArchive)
	if err != nil {
		return contracts.SkillMarketPackage{}, errors.New("skill market archive is unavailable")
	}
	defer file.Close()
	archive, err := io.ReadAll(io.LimitReader(file, entry.ArchiveBytes+1))
	if err != nil || int64(len(archive)) != entry.ArchiveBytes {
		return contracts.SkillMarketPackage{}, errors.New("skill market archive is unavailable")
	}
	digest := sha256.Sum256(archive)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), entry.ArchiveDigest) {
		clear(archive)
		return contracts.SkillMarketPackage{}, errors.New("skill market archive integrity check failed")
	}
	return contracts.SkillMarketPackage{ID: entry.ID, Name: entry.Name, Description: entry.Description, Version: entry.Version, Archive: archive}, nil
}

func (s *Store) resolveArchivePath(objectKey string) (string, error) {
	cleanKey := filepath.Clean(filepath.FromSlash(objectKey))
	if filepath.IsAbs(cleanKey) || cleanKey == "." || cleanKey == ".." || strings.HasPrefix(cleanKey, ".."+string(filepath.Separator)) {
		return "", errors.New("invalid skill market object key")
	}
	resolvedRoot, err := filepath.EvalSymlinks(s.archiveRoot)
	if err != nil {
		return "", err
	}
	resolvedArchive, err := filepath.EvalSymlinks(filepath.Join(s.archiveRoot, cleanKey))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedArchive)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("invalid skill market object key")
	}
	return resolvedArchive, nil
}

func safeMarketFile(value string) string {
	if marketIDPattern.MatchString(value) {
		return value
	}
	return "entry"
}

func (s *Store) PublishPackage(ctx context.Context, input contracts.SkillMarketPublishInput, archive []byte) (contracts.SkillMarketEntry, error) {
	if !marketIDPattern.MatchString(input.ID) || len(archive) == 0 || len(archive) > 50<<20 {
		return contracts.SkillMarketEntry{}, errors.New("invalid skill market package")
	}
	digest := sha256.Sum256(archive)
	objects := filepath.Join(s.archiveRoot, "objects")
	if err := os.MkdirAll(objects, 0o700); err != nil {
		return contracts.SkillMarketEntry{}, fmt.Errorf("create skill market object storage: %w", err)
	}
	temporary, err := os.CreateTemp(objects, ".publish-*.zip")
	if err != nil {
		return contracts.SkillMarketEntry{}, err
	}
	temporaryPath := temporary.Name()
	activated := false
	defer func() {
		temporary.Close()
		if !activated {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return contracts.SkillMarketEntry{}, err
	}
	if _, err := temporary.Write(archive); err != nil {
		return contracts.SkillMarketEntry{}, err
	}
	if err := temporary.Close(); err != nil {
		return contracts.SkillMarketEntry{}, err
	}
	objectKey := filepath.ToSlash(filepath.Join("objects", input.ID+".zip"))
	destination := filepath.Join(s.archiveRoot, filepath.FromSlash(objectKey))
	if _, err := os.Stat(destination); err == nil {
		return contracts.SkillMarketEntry{}, errors.New("skill market package already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return contracts.SkillMarketEntry{}, err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return contracts.SkillMarketEntry{}, err
	}
	activated = true
	entry, err := s.Publish(ctx, Entry{
		ID: input.ID, Name: input.Name, Description: input.Description, Version: input.Version,
		PublisherUsername: input.PublisherUsername, PublisherDisplayName: input.PublisherDisplayName,
		ObjectKey: objectKey, ArchiveDigest: hex.EncodeToString(digest[:]), ArchiveBytes: int64(len(archive)),
	})
	if err != nil {
		_ = os.Remove(destination)
		return contracts.SkillMarketEntry{}, err
	}
	return contracts.SkillMarketEntry{
		ID: entry.ID, Name: entry.Name, Description: entry.Description, Version: entry.Version,
		Publisher: contracts.Publisher{Username: entry.PublisherUsername, DisplayName: entry.PublisherDisplayName},
		UpdatedAt: entry.UpdatedAt.UTC(), ArchiveBytes: entry.ArchiveBytes, CanDelete: true,
	}, nil
}

const marketSelect = `SELECT id,name,description,version,publisher_username,publisher_display_name,object_key,archive_digest,archive_bytes,status,created_at,updated_at FROM skill_market_entries`

type scanner interface{ Scan(...any) error }

func scanEntry(row scanner) (Entry, error) {
	var entry Entry
	var createdAt, updatedAt int64
	err := row.Scan(&entry.ID, &entry.Name, &entry.Description, &entry.Version, &entry.PublisherUsername,
		&entry.PublisherDisplayName, &entry.ObjectKey, &entry.ArchiveDigest, &entry.ArchiveBytes, &entry.Status, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Entry{}, ErrNotFound
	}
	if err != nil {
		return Entry{}, err
	}
	entry.CreatedAt = time.UnixMilli(createdAt)
	entry.UpdatedAt = time.UnixMilli(updatedAt)
	return entry, nil
}
