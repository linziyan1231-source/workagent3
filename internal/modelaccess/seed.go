package modelaccess

import (
	"context"
	"fmt"

	"workagent3/internal/quota"
)

// Internal model IDs the whole platform binds to: Portal reservations, quota
// budgets, the SID-private Harness projection, and gateway usage settlement
// matching all use these stable logical IDs while the real upstream model
// (the employee-manager modelGateway.codexModel) rides along as an alias.
const (
	HarnessDefaultModelID = "harness-default"
	CodexNativeModelID    = "codex-native"
	KimiNativeModelID     = "kimi-native"
)

// SeedCatalog upserts the internal model catalog shared by the Portal
// bootstrap and the Employee Manager provision seeding. Upserts keep both
// writers convergent; per-SID authorizations are seeded separately.
func SeedCatalog(ctx context.Context, store *Store, codexModel string) error {
	for _, model := range []Model{
		{ID: HarnessDefaultModelID, ProviderID: "harness", DisplayName: "Harness (" + codexModel + ")", Aliases: []string{"default", codexModel}, ContextWindow: 128000, Health: Unknown},
		// The codex provider runs through the same shared Codex model, so the
		// alias lets settlement matching attribute gateway usage records (which
		// carry the real model name) to codex-native reservations.
		{ID: CodexNativeModelID, ProviderID: "codex", DisplayName: "Codex", Aliases: []string{codexModel}, ContextWindow: 128000, Health: Unknown},
		{ID: KimiNativeModelID, ProviderID: "kimi", DisplayName: "Kimi", Aliases: []string{}, ContextWindow: 128000, Health: Unknown},
		{ID: quota.SpeechTranscriptionModelID, ProviderID: "speech", DisplayName: "Speech transcription", Aliases: []string{}, ContextWindow: 1, Health: Unknown},
	} {
		if err := store.UpsertModel(ctx, model); err != nil {
			return fmt.Errorf("seed model %s: %w", model.ID, err)
		}
	}
	return nil
}
