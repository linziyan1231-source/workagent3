// Package acpcatalog owns the administrator-approved ACP release catalog.
package acpcatalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var ErrNotFound = errors.New("acp_catalog_not_found")
var ErrDisabled = errors.New("acp_catalog_disabled")
var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var envPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,79}$`)

type CredentialField struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Environment string `json:"environment"`
	Required    bool   `json:"required"`
}
type Entry struct {
	ID               string            `json:"id"`
	Label            string            `json:"label"`
	PackageRef       string            `json:"packageRef"`
	Revision         string            `json:"revision"`
	Command          string            `json:"command"`
	ResolvedCommand  string            `json:"resolvedCommand,omitempty"`
	Args             []string          `json:"args"`
	CredentialFields []CredentialField `json:"credentialFields"`
	BillingModelID   string            `json:"billingModelId"`
	Enabled          bool              `json:"enabled"`
	PermissionModes  map[string]string `json:"permissionModes,omitempty"`
}
type Selection struct {
	Revision string `json:"revision"`
	Enabled  bool   `json:"enabled"`
}
type Store struct {
	mu        sync.RWMutex
	entries   map[string]map[string]Entry
	selected  map[string]Selection
	statePath string
}

// The manifest is release configuration. HTTP callers can only select or disable
// its immutable entries; they cannot submit executable paths or argument lists.
func Open(manifestPath, statePath string) (*Store, error) {
	s := &Store{entries: map[string]map[string]Entry{}, selected: map[string]Selection{}, statePath: statePath}
	if manifestPath == "" {
		return s, nil
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	var rows []Entry
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, err
	}
	base, err := filepath.Abs(filepath.Dir(manifestPath))
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if err := Validate(row); err != nil {
			return nil, err
		}
		if filepath.IsAbs(row.PackageRef) || filepath.IsAbs(row.Command) {
			return nil, errors.New("ACP package and command must be relative to the approved release")
		}
		packageRoot := filepath.Join(base, row.PackageRef)
		command := filepath.Join(packageRoot, row.Command)
		if !inside(base, packageRoot) || !inside(packageRoot, command) {
			return nil, errors.New("ACP command is outside its approved package")
		}
		realBase, err := filepath.EvalSymlinks(base)
		if err != nil {
			return nil, err
		}
		realPackage, err := filepath.EvalSymlinks(packageRoot)
		if err != nil || !inside(realBase, realPackage) {
			return nil, errors.New("ACP package resolves outside its approved release")
		}
		real, err := filepath.EvalSymlinks(command)
		if err != nil || !inside(realPackage, real) {
			return nil, errors.New("ACP executable is missing or resolves outside its package")
		}
		info, err := os.Stat(real)
		if err != nil || !info.Mode().IsRegular() {
			return nil, errors.New("ACP executable is not a regular file")
		}
		row.ResolvedCommand = real
		if row.Args == nil {
			row.Args = []string{}
		}
		if row.CredentialFields == nil {
			row.CredentialFields = []CredentialField{}
		}
		if s.entries[row.ID] == nil {
			s.entries[row.ID] = map[string]Entry{}
		}
		if _, found := s.entries[row.ID][row.Revision]; found {
			return nil, errors.New("duplicate ACP catalog revision")
		}
		s.entries[row.ID][row.Revision] = row
		if _, found := s.selected[row.ID]; !found {
			s.selected[row.ID] = Selection{Revision: row.Revision, Enabled: row.Enabled}
		}
	}
	if statePath != "" {
		data, err = os.ReadFile(statePath)
		if err == nil {
			var saved map[string]Selection
			if err := json.Unmarshal(data, &saved); err != nil {
				return nil, err
			}
			for id, selection := range saved {
				// A removed release stays disabled instead of silently changing versions.
				if _, found := s.entries[id][selection.Revision]; !found {
					selection.Enabled = false
				}
				s.selected[id] = selection
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return s, nil
}
func inside(root, target string) bool {
	relative, err := filepath.Rel(root, target)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
func Validate(row Entry) error {
	if !idPattern.MatchString(row.ID) || strings.TrimSpace(row.Label) == "" || row.Revision == "" || len(row.Revision) > 120 || row.PackageRef == "" || row.Command == "" || row.BillingModelID == "" || len(row.Args) > 100 || len(row.CredentialFields) > 20 {
		return errors.New("invalid ACP catalog entry")
	}
	seen := map[string]bool{}
	environments := map[string]bool{}
	for _, field := range row.CredentialFields {
		if !idPattern.MatchString(field.ID) || field.Label == "" || !envPattern.MatchString(field.Environment) || seen[field.ID] || environments[field.Environment] || strings.HasPrefix(field.Environment, "WORKAGENT_") {
			return errors.New("invalid ACP credential field")
		}
		switch field.Environment {
		case "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD", "ACP_HOME", "DSH_HOME", "CODEX_HOME", "KIMI_CODE_HOME":
			return errors.New("ACP credential cannot replace execution environment")
		}
		seen[field.ID] = true
		environments[field.Environment] = true
	}
	for mode, value := range row.PermissionModes {
		if (mode != "read_only" && mode != "workspace_write" && mode != "full_access") || value == "" {
			return errors.New("invalid ACP permission mapping")
		}
	}
	return nil
}
func (s *Store) List() []Entry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows := []Entry{}
	for id, selection := range s.selected {
		if row, ok := s.entries[id][selection.Revision]; ok {
			row.Enabled = selection.Enabled
			rows = append(rows, row)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	return rows
}
func (s *Store) Revisions() []Entry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows := []Entry{}
	for id, versions := range s.entries {
		for _, row := range versions {
			row.Enabled = s.selected[id].Enabled && s.selected[id].Revision == row.Revision
			rows = append(rows, row)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID+rows[i].Revision < rows[j].ID+rows[j].Revision })
	return rows
}
func (s *Store) Resolve(id, revision string) (Entry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	selection, exists := s.selected[id]
	if !exists {
		return Entry{}, ErrNotFound
	}
	if !selection.Enabled {
		return Entry{}, ErrDisabled
	}
	if revision == "" {
		revision = selection.Revision
	}
	row, exists := s.entries[id][revision]
	if !exists {
		return Entry{}, ErrNotFound
	}
	row.Enabled = true
	return row, nil
}
func (s *Store) Select(id string, selection Selection) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.entries[id][selection.Revision]; !exists {
		return ErrNotFound
	}
	next := make(map[string]Selection, len(s.selected))
	for key, value := range s.selected {
		next[key] = value
	}
	next[id] = selection
	if s.statePath == "" {
		return errors.New("ACP catalog state path is not configured")
	}
	data, _ := json.MarshalIndent(next, "", "  ")
	if err := os.MkdirAll(filepath.Dir(s.statePath), 0700); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.%d.tmp", s.statePath, os.Getpid())
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.statePath); err != nil {
		return err
	}
	s.selected = next
	return nil
}
