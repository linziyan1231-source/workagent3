package skillmigration

import (
	"testing"
	"time"
)

func TestProjectPresetsRemapsCapabilityIDsAndClassifiesReview(t *testing.T) {
	manifest := Manifest{SchemaVersion: 1, SID: "S-1-5-21-1", CapturedAt: time.Now(), Presets: []PresetAsset{{
		OldID: "assistant", Name: "Assistant", Engine: "codex", Enabled: true, SkillIDs: []string{"old-skill"}, MCPServerIDs: []string{"old-mcp"}, ApprovalPolicy: "on_risk", MigrationIssues: []string{},
	}}}
	projection, results, err := ProjectPresets(manifest,
		[]Result{{SourceID: "old-skill", TargetID: "new-skill", Kind: "skill", Status: Ready}},
		[]Result{{SourceID: "old-mcp", TargetID: "new-mcp", Kind: "mcp_server", Status: NeedsAuth}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Presets[0].SkillIDs[0] != "new-skill" || projection.Presets[0].MCPServerIDs[0] != "new-mcp" {
		t.Fatalf("projection = %#v", projection.Presets[0])
	}
	if results[0].Status != NeedsReview || results[0].Kind != "preset" {
		t.Fatalf("results = %#v", results)
	}
}

func TestProjectPresetsRejectsDuplicateSourceIDs(t *testing.T) {
	asset := PresetAsset{OldID: "duplicate", Name: "Duplicate", Engine: "harness", ApprovalPolicy: "on_risk"}
	_, _, err := ProjectPresets(Manifest{SchemaVersion: 1, SID: "S-1-5-21-1", CapturedAt: time.Now(), Presets: []PresetAsset{asset, asset}}, nil, nil)
	if err == nil {
		t.Fatal("duplicate preset was accepted")
	}
}
