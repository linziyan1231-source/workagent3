package skillruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("skill not found")

var skillIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type Entry struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Description          string   `json:"description"`
	Version              string   `json:"version"`
	Source               string   `json:"source"`
	Enabled              bool     `json:"enabled"`
	RelativePath         string   `json:"relativePath"`
	RequiredMCPServerIDs []string `json:"requiredMcpServerIds"`
}

type InstallInput struct {
	Entry
	SourceDirectory string
}

type Store struct {
	db         *sql.DB
	skillsRoot string
	now        func() time.Time
}

func Open(databasePath, skillsRoot string) (*Store, error) {
	if !filepath.IsAbs(skillsRoot) {
		return nil, errors.New("skill root must be absolute")
	}
	for _, directory := range []string{skillsRoot, filepath.Join(skillsRoot, ".staging"), filepath.Join(skillsRoot, ".trash")} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, fmt.Errorf("create skill directory: %w", err)
		}
	}
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return nil, fmt.Errorf("open skill runtime: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database, skillsRoot: skillsRoot, now: time.Now}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('builtin','managed','market','user')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  relative_path TEXT NOT NULL UNIQUE,
  required_mcp_server_ids_json TEXT NOT NULL CHECK (json_valid(required_mcp_server_ids_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`)
	if err != nil {
		return fmt.Errorf("migrate skill runtime: %w", err)
	}
	return nil
}

func (s *Store) Install(ctx context.Context, input InstallInput) (Entry, error) {
	if err := validateInstall(input); err != nil {
		return Entry{}, err
	}
	source, err := filepath.Abs(input.SourceDirectory)
	if err != nil {
		return Entry{}, err
	}
	if err := validateSkillTree(source); err != nil {
		return Entry{}, err
	}
	if _, err := os.Stat(filepath.Join(source, "SKILL.md")); err != nil {
		return Entry{}, errors.New("skill package is missing SKILL.md")
	}
	stagingParent := filepath.Join(s.skillsRoot, ".staging")
	staging, err := os.MkdirTemp(stagingParent, safeSegment(input.ID)+"-")
	if err != nil {
		return Entry{}, err
	}
	defer os.RemoveAll(staging)
	bundleName := safeSegment(input.Name)
	bundle := filepath.Join(staging, bundleName)
	if err := copySkillTree(source, bundle); err != nil {
		return Entry{}, err
	}
	destination := filepath.Join(s.skillsRoot, safeSegment(input.ID))
	if _, err := os.Stat(destination); err == nil {
		return Entry{}, errors.New("skill is already installed")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Entry{}, err
	}
	if err := os.Rename(staging, destination); err != nil {
		return Entry{}, fmt.Errorf("activate skill package: %w", err)
	}
	activated := true
	defer func() {
		if activated {
			_ = os.RemoveAll(destination)
		}
	}()
	requiredMCP, _ := json.Marshal(input.RequiredMCPServerIDs)
	relativePath := filepath.ToSlash(filepath.Join(safeSegment(input.ID), bundleName))
	stamp := s.now().UTC().UnixMilli()
	_, err = s.db.ExecContext(ctx, `INSERT INTO skills
(id,name,description,version,source,enabled,relative_path,required_mcp_server_ids_json,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?)`, input.ID, strings.TrimSpace(input.Name), strings.TrimSpace(input.Description), strings.TrimSpace(input.Version),
		input.Source, input.Enabled, relativePath, string(requiredMCP), stamp, stamp)
	if err != nil {
		return Entry{}, fmt.Errorf("store installed skill: %w", err)
	}
	activated = false
	return s.Get(ctx, input.ID)
}

func (s *Store) Get(ctx context.Context, id string) (Entry, error) {
	return scanEntry(s.db.QueryRowContext(ctx, skillSelect+` WHERE id=?`, id))
}

func (s *Store) List(ctx context.Context) ([]Entry, error) {
	rows, err := s.db.QueryContext(ctx, skillSelect+` ORDER BY name,id`)
	if err != nil {
		return nil, fmt.Errorf("list skills: %w", err)
	}
	defer rows.Close()
	entries := make([]Entry, 0)
	for rows.Next() {
		entry, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (s *Store) SetEnabled(ctx context.Context, id string, enabled bool) (Entry, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE skills SET enabled=?,updated_at=? WHERE id=?`, enabled, s.now().UTC().UnixMilli(), id)
	if err != nil {
		return Entry{}, fmt.Errorf("set skill enabled state: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Entry{}, ErrNotFound
	}
	return s.Get(ctx, id)
}

func (s *Store) Remove(ctx context.Context, id string) error {
	entry, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	installed := filepath.Join(s.skillsRoot, filepath.FromSlash(strings.Split(entry.RelativePath, "/")[0]))
	trash := filepath.Join(s.skillsRoot, ".trash", safeSegment(id)+"-"+fmt.Sprint(s.now().UTC().UnixMilli()))
	if err := os.Rename(installed, trash); err != nil {
		return fmt.Errorf("archive removed skill: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM skills WHERE id=?`, id)
	if err != nil {
		_ = os.Rename(trash, installed)
		return fmt.Errorf("remove skill metadata: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		_ = os.Rename(trash, installed)
		return ErrNotFound
	}
	return nil
}

func (s *Store) RootFor(entry Entry) string {
	return filepath.Join(s.skillsRoot, filepath.FromSlash(strings.Split(entry.RelativePath, "/")[0]))
}

const skillSelect = `SELECT id,name,description,version,source,enabled,relative_path,required_mcp_server_ids_json FROM skills`

type scanner interface{ Scan(...any) error }

func scanEntry(row scanner) (Entry, error) {
	var entry Entry
	var enabled int
	var requiredMCPJSON string
	err := row.Scan(&entry.ID, &entry.Name, &entry.Description, &entry.Version, &entry.Source, &enabled, &entry.RelativePath, &requiredMCPJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return Entry{}, ErrNotFound
	}
	if err != nil {
		return Entry{}, err
	}
	if err := json.Unmarshal([]byte(requiredMCPJSON), &entry.RequiredMCPServerIDs); err != nil {
		return Entry{}, fmt.Errorf("decode skill MCP dependencies: %w", err)
	}
	entry.Enabled = enabled == 1
	return entry, nil
}

func validateInstall(input InstallInput) error {
	if !skillIDPattern.MatchString(input.ID) || strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.Version) == "" ||
		!filepath.IsAbs(input.SourceDirectory) || len(input.Description) > 4000 {
		return errors.New("invalid skill package metadata")
	}
	if input.Source != "builtin" && input.Source != "managed" && input.Source != "market" && input.Source != "user" {
		return errors.New("invalid skill source")
	}
	for _, id := range input.RequiredMCPServerIDs {
		if strings.TrimSpace(id) == "" {
			return errors.New("invalid required MCP server")
		}
	}
	return nil
}

func safeSegment(value string) string {
	var builder strings.Builder
	for _, character := range strings.ToLower(strings.TrimSpace(value)) {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-' || character == '_' {
			builder.WriteRune(character)
		} else {
			builder.WriteByte('-')
		}
	}
	result := strings.Trim(builder.String(), "-_")
	if result == "" {
		return "skill"
	}
	return result
}

func validateSkillTree(root string) error {
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return errors.New("skill package source must be a directory")
	}
	files := 0
	var totalSize int64
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
			return fmt.Errorf("skill package contains a reparse point: %s", filepath.Base(path))
		}
		if !info.IsDir() {
			if !info.Mode().IsRegular() {
				return errors.New("skill package contains a non-regular file")
			}
			files++
			totalSize += info.Size()
			if files > 10_000 || totalSize > 512<<20 {
				return errors.New("skill package exceeds installation limits")
			}
		}
		return nil
	})
}

func copySkillTree(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return errors.New("skill package path escapes source")
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		outputCloseErr := output.Close()
		inputCloseErr := input.Close()
		if copyErr != nil {
			return copyErr
		}
		if outputCloseErr != nil {
			return outputCloseErr
		}
		return inputCloseErr
	})
}
