package managedskills

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"workagent3/internal/skillruntime"
)

type Manifest struct {
	SchemaVersion int       `json:"schemaVersion"`
	Skills        []Package `json:"skills"`
}

type Package struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Description          string   `json:"description"`
	Version              string   `json:"version"`
	RelativePath         string   `json:"relativePath"`
	EnabledByDefault     bool     `json:"enabledByDefault"`
	RequiredMCPServerIDs []string `json:"requiredMcpServerIds"`
	SkillSubdirectory    string   `json:"skillSubdirectory,omitempty"`
}

func Sync(ctx context.Context, releaseRoot string, skills *skillruntime.Store) error {
	if skills == nil || !filepath.IsAbs(releaseRoot) {
		return errors.New("managed skill release root and runtime are required")
	}
	manifest, err := loadManifest(filepath.Join(releaseRoot, "managed-skills.json"))
	if err != nil {
		return err
	}
	seenIDs, seenNames := map[string]struct{}{}, map[string]struct{}{}
	for _, pack := range manifest.Skills {
		nameKey := strings.ToLower(strings.TrimSpace(pack.Name))
		if pack.ID == "" || nameKey == "" || pack.Version == "" || pack.RelativePath == "" {
			return errors.New("invalid managed skill package")
		}
		if _, duplicate := seenIDs[pack.ID]; duplicate {
			return errors.New("duplicate managed skill id")
		}
		if _, duplicate := seenNames[nameKey]; duplicate {
			return errors.New("duplicate managed skill name")
		}
		seenIDs[pack.ID], seenNames[nameKey] = struct{}{}, struct{}{}
		source, err := managedSource(releaseRoot, pack.RelativePath)
		if err != nil {
			return err
		}
		enabled := pack.EnabledByDefault
		existing, getErr := skills.Get(ctx, pack.ID)
		if errors.Is(getErr, skillruntime.ErrNotFound) {
			existing, getErr = skills.GetByName(ctx, pack.Name)
		}
		if getErr == nil {
			if existing.Source != "managed" {
				return errors.New("managed skill conflicts with another source")
			}
			enabled = existing.Enabled
			if existing.ID == pack.ID && existing.Version == pack.Version {
				continue
			}
		} else if !errors.Is(getErr, skillruntime.ErrNotFound) {
			return getErr
		}
		_, err = skills.InstallManaged(ctx, skillruntime.InstallInput{
			Entry: skillruntime.Entry{
				ID: pack.ID, Name: pack.Name, Description: pack.Description, Version: pack.Version,
				Source: "managed", Enabled: enabled, RequiredMCPServerIDs: pack.RequiredMCPServerIDs,
			},
			SourceDirectory:   source,
			SkillSubdirectory: pack.SkillSubdirectory,
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func loadManifest(path string) (Manifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return Manifest{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if decoder.Decode(&manifest) != nil || decoder.Decode(&struct{}{}) != io.EOF || manifest.SchemaVersion != 1 {
		return Manifest{}, errors.New("invalid managed skill manifest")
	}
	return manifest, nil
}

func managedSource(root, relativePath string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(relativePath))
	if filepath.IsAbs(clean) || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("invalid managed skill path")
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	source, err := filepath.EvalSymlinks(filepath.Join(root, clean))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, source)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("managed skill path escapes release root")
	}
	return source, nil
}
