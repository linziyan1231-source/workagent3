package skillmigration

import (
	"errors"
	"sort"
	"strings"
	"time"
)

type PresetProjection struct {
	SchemaVersion int           `json:"schemaVersion"`
	SID           string        `json:"sid"`
	CapturedAt    time.Time     `json:"capturedAt"`
	Presets       []PresetAsset `json:"presets"`
}

func ProjectPresets(manifest Manifest, skillResults, mcpResults []Result) (PresetProjection, []Result, error) {
	if manifest.SchemaVersion != 1 || !validSID(manifest.SID) || manifest.CapturedAt.IsZero() {
		return PresetProjection{}, nil, errors.New("invalid migration manifest")
	}
	skills := resultMapping(skillResults, "skill")
	mcp := resultMapping(mcpResults, "mcp_server")
	projection := PresetProjection{SchemaVersion: 1, SID: manifest.SID, CapturedAt: manifest.CapturedAt.UTC(), Presets: []PresetAsset{}}
	results := make([]Result, 0, len(manifest.Presets))
	seen := map[string]struct{}{}
	for _, source := range manifest.Presets {
		if strings.TrimSpace(source.OldID) == "" || strings.TrimSpace(source.Name) == "" {
			results = append(results, Result{SourceID: source.OldID, Kind: "preset", Status: Failed, Reason: "invalid_preset_metadata"})
			continue
		}
		if _, duplicate := seen[source.OldID]; duplicate {
			return PresetProjection{}, nil, errors.New("duplicate legacy preset: " + source.OldID)
		}
		seen[source.OldID] = struct{}{}
		preset := source
		preset.SkillBindingIDs = uniqueStrings(preset.SkillBindingIDs)
		preset.MCPBindingIDs = uniqueStrings(preset.MCPBindingIDs)
		preset.SkillIDs, preset.MigrationIssues = remapPresetBindings(source.SkillIDs, skills, "skill", preset.MigrationIssues)
		preset.MCPServerIDs, preset.MigrationIssues = remapPresetBindings(source.MCPServerIDs, mcp, "mcp", preset.MigrationIssues)
		preset.MigrationIssues = uniqueStrings(preset.MigrationIssues)
		projection.Presets = append(projection.Presets, preset)
		status, reason := Ready, ""
		if len(preset.MigrationIssues) != 0 {
			status, reason = NeedsReview, strings.Join(preset.MigrationIssues, ",")
		}
		results = append(results, Result{SourceID: source.OldID, Kind: "preset", Status: status, Reason: reason})
	}
	sort.Slice(projection.Presets, func(left, right int) bool { return projection.Presets[left].OldID < projection.Presets[right].OldID })
	return projection, results, nil
}

func resultMapping(results []Result, kind string) map[string]Result {
	mapping := map[string]Result{}
	for _, result := range results {
		if result.Kind == kind {
			mapping[result.SourceID] = result
		}
	}
	return mapping
}

func remapPresetBindings(source []string, mapping map[string]Result, bindingKind string, issues []string) ([]string, []string) {
	result := make([]string, 0, len(source))
	for _, oldID := range source {
		migration, ok := mapping[oldID]
		if !ok || migration.TargetID == "" {
			issues = append(issues, bindingKind+"_mapping_missing:"+oldID)
			continue
		}
		result = append(result, migration.TargetID)
		if migration.Status != Ready || migration.Reason == "source_deleted" {
			issues = append(issues, bindingKind+"_not_ready:"+oldID)
		}
	}
	return uniqueStrings(result), issues
}
