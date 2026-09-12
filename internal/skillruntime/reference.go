package skillruntime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Reference registers an existing global installation without copying its
// resources. The caller supplies an account-scoped, verified source directory.
func (s *Store) Reference(ctx context.Context, entry Entry, directory string) (Entry, error) {
	if !filepath.IsAbs(directory) {
		return Entry{}, errors.New("skill reference must be absolute")
	}
	if err := validateSkillDocument(filepath.Join(directory, "SKILL.md")); err != nil {
		return Entry{}, err
	}
	if !skillIDPattern.MatchString(entry.ID) || entry.Name == "" {
		return Entry{}, errors.New("invalid skill reference")
	}
	previous, err := s.Get(ctx, entry.ID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Entry{}, err
	}
	if err == nil && previous.ReferenceDirectory == "" {
		return Entry{}, errors.New("cannot replace an installed package with a reference")
	}
	byName, nameErr := s.GetByName(ctx, entry.Name)
	if nameErr == nil && byName.ID != entry.ID {
		return Entry{}, errors.New("skill name already registered")
	}
	if nameErr != nil && !errors.Is(nameErr, ErrNotFound) {
		return Entry{}, nameErr
	}
	relative := filepath.Join(entry.ID, safeSegment(entry.Name))
	destination := filepath.Join(s.skillsRoot, relative)
	if err := EnsureDirectoryReference(destination, directory); err != nil {
		return Entry{}, err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO native_skill_paths(path) VALUES(?)`, filepath.Join(directory, "SKILL.md")); err != nil {
		return Entry{}, err
	}
	required, _ := json.Marshal(nonNilStrings(entry.RequiredMCPServerIDs))
	commands, _ := json.Marshal(nonNilStrings(entry.RequiredCommands))
	if len(entry.CompatibleEngines) == 0 {
		entry.CompatibleEngines = []string{"codex", "kimi", "harness"}
	}
	compatible, _ := json.Marshal(entry.CompatibleEngines)
	stamp := s.now().UTC().UnixMilli()
	_, err = s.db.ExecContext(ctx, `INSERT INTO skills
 (id,name,description,version,source,enabled,relative_path,required_mcp_server_ids_json,required_commands_json,created_at,updated_at,reference_directory,compatible_engines_json)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
 name=excluded.name,description=excluded.description,version=excluded.version,reference_directory=excluded.reference_directory,
 required_mcp_server_ids_json=excluded.required_mcp_server_ids_json,required_commands_json=excluded.required_commands_json,compatible_engines_json=excluded.compatible_engines_json,updated_at=excluded.updated_at`,
		entry.ID, entry.Name, entry.Description, entry.Version, "user", entry.Enabled, filepath.ToSlash(relative), string(required), string(commands), stamp, stamp, directory, string(compatible))
	if err != nil {
		return Entry{}, err
	}
	return s.Get(ctx, entry.ID)
}

// Only directory references are replaced. Real directories are never removed.
func EnsureDirectoryReference(link, target string) error {
	if info, err := os.Lstat(link); err == nil {
		if info.Mode()&os.ModeSymlink == 0 && !isReparsePoint(info) {
			return errors.New("skill reference conflicts with an existing directory")
		}
		current, err := filepath.EvalSymlinks(link)
		resolved, resolveErr := filepath.EvalSymlinks(target)
		if err == nil && resolveErr == nil && current == resolved {
			return nil
		}
		if err := os.Remove(link); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(link), 0700); err != nil {
		return err
	}
	return createDirectoryReference(link, target)
}

func RemoveDirectoryReference(link string) error {
	info, err := os.Lstat(link)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 && !isReparsePoint(info) {
		return errors.New("refusing to remove an ordinary skill directory")
	}
	return os.Remove(link)
}

func (s *Store) SetSourceAvailable(ctx context.Context, id string, available bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE skills SET source_available=? WHERE id=? AND source_available<>?`, available, id, available)
	return err
}

// Retain original paths after deletion so native discovery cannot resurrect a removed skill.
func (s *Store) NativeSkillPaths(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT path FROM native_skill_paths ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := []string{}
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, rows.Err()
}
