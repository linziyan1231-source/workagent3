package userhost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectModelAccessInjectsConfiguredHarnessModel(t *testing.T) {
	dshHome := t.TempDir()
	if err := projectModelAccess(dshHome, "gpt-5.6-sol"); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(filepath.Join(dshHome, "workagent", "model-access.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Models []struct {
			ID          string   `json:"id"`
			ProviderID  string   `json:"providerId"`
			DisplayName string   `json:"displayName"`
			Aliases     []string `json:"aliases"`
		} `json:"models"`
		AuthorizedModelIDs []string `json:"authorizedModelIds"`
	}
	if err := json.Unmarshal(payload, &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Models) != 3 || len(catalog.AuthorizedModelIDs) != 3 {
		t.Fatalf("unexpected catalog: %s", payload)
	}
	harness := catalog.Models[0]
	if harness.ID != "harness-default" || harness.ProviderID != "harness" {
		t.Fatalf("stable Harness model identity changed: %+v", harness)
	}
	if harness.DisplayName != "Harness (gpt-5.6-sol)" || len(harness.Aliases) != 2 || harness.Aliases[1] != "gpt-5.6-sol" {
		t.Fatalf("configured model was not injected into the Harness entry: %+v", harness)
	}

	// Re-projection over an existing catalog (model change) must succeed.
	if err := projectModelAccess(dshHome, "gpt-5.6-terra"); err != nil {
		t.Fatal(err)
	}
	payload, err = os.ReadFile(filepath.Join(dshHome, "workagent", "model-access.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, &catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.Models[0].DisplayName != "Harness (gpt-5.6-terra)" {
		t.Fatalf("re-projection kept the stale model: %s", payload)
	}
}
