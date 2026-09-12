package userhost

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"

	"github.com/pelletier/go-toml/v2"
	"workagent3/internal/skillruntime"
)

// Kimi Code 0.29 ACP ignores the parent CLI's --skills-dir override but
// honors extra_skill_dirs. Keep its native project discovery intact and
// project only enabled global roots through that supported configuration.
func (s *capabilitySync) reconcileKimiSkills(ctx context.Context) error {
	path := filepath.Join(s.dataRoot, "native", "kimi", "config.toml")
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	config := map[string]any{}
	if len(data) > 0 {
		if err := toml.Unmarshal(data, &config); err != nil {
			return errors.New("kimi_config_invalid")
		}
	}
	owned := map[string]bool{}
	for _, row := range s.rows {
		if row.Kind == "skill" && row.ResourceID != "" {
			owned[s.imports.skills.RootFor(skillruntime.Entry{RelativePath: row.ResourceID + "/skill"})] = true
		}
	}
	previous := []string{}
	if value, ok := config["extra_skill_dirs"]; ok {
		values, ok := value.([]any)
		if !ok {
			return errors.New("kimi_skill_roots_invalid")
		}
		for _, value := range values {
			text, ok := value.(string)
			if !ok {
				return errors.New("kimi_skill_root_invalid")
			}
			previous = append(previous, text)
		}
	}
	next := []string{}
	for _, path := range previous {
		if !owned[path] {
			next = append(next, path)
		}
	}
	managed := []string{}
	entries, err := s.imports.skills.List(ctx)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.ReferenceDirectory == "" || !entry.Enabled || !slices.Contains(entry.CompatibleEngines, "kimi") {
			continue
		}
		available := false
		for _, row := range s.rows {
			if row.ResourceID == entry.ID && row.Status == "ready" {
				available = true
				break
			}
		}
		if available {
			managed = append(managed, s.imports.skills.RootFor(entry))
		}
	}
	sort.Strings(managed)
	next = append(next, managed...)
	if reflect.DeepEqual(previous, next) {
		return nil
	}
	config["extra_skill_dirs"] = next
	encoded, err := toml.Marshal(config)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temporary := path + ".capability-sync.tmp"
	if err := os.WriteFile(temporary, encoded, 0600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
