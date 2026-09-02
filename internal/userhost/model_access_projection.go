package userhost

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// modelAccessEntry mirrors modelCatalogEntrySchema in
// packages/contracts/src/model-access.ts. Keep the two in sync.
type modelAccessEntry struct {
	ID                    string   `json:"id"`
	ProviderID            string   `json:"providerId"`
	DisplayName           string   `json:"displayName"`
	Aliases               []string `json:"aliases"`
	ContextWindow         int      `json:"contextWindow"`
	InputPricePerMillion  *float64 `json:"inputPricePerMillion"`
	OutputPricePerMillion *float64 `json:"outputPricePerMillion"`
	Health                string   `json:"health"`
}

// projectModelAccess writes the SID-private Harness model catalog consumed by
// the harness-bundle ModelAccessStore. The stable logical IDs stay intact
// (presets and quota accounting bind to them) while the Harness entry carries
// the real configured model (= the employee-manager CodexModel) instead of
// being a display-only placeholder.
func projectModelAccess(dshHome, harnessModel string) error {
	catalog := struct {
		Models             []modelAccessEntry `json:"models"`
		AuthorizedModelIDs []string           `json:"authorizedModelIds"`
	}{
		Models: []modelAccessEntry{
			{ID: "harness-default", ProviderID: "harness", DisplayName: "Harness (" + harnessModel + ")", Aliases: []string{"default", harnessModel}, ContextWindow: 128000, Health: "unknown"},
			{ID: "codex-native", ProviderID: "codex", DisplayName: "Codex native", Aliases: []string{}, ContextWindow: 128000, Health: "unknown"},
			{ID: "kimi-native", ProviderID: "kimi", DisplayName: "Kimi native", Aliases: []string{}, ContextWindow: 128000, Health: "unknown"},
		},
		AuthorizedModelIDs: []string{"harness-default", "codex-native", "kimi-native"},
	}
	payload, err := json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		return err
	}
	directory := filepath.Join(dshHome, "workagent")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".model-access-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(payload, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	target := filepath.Join(directory, "model-access.json")
	if err := os.Rename(temporaryPath, target); err != nil {
		// Windows refuses to rename over an existing file.
		if removeErr := os.Remove(target); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return removeErr
		}
		if err := os.Rename(temporaryPath, target); err != nil {
			return fmt.Errorf("activate Harness model access projection: %w", err)
		}
	}
	return nil
}
