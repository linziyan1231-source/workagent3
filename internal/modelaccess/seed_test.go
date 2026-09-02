package modelaccess

import (
	"errors"
	"testing"

	"workagent3/internal/quota"
)

func TestSeedCatalogIsIdempotentAndCoversInternalModels(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := t.Context()
	for round := 0; round < 2; round++ {
		if err := SeedCatalog(ctx, store, "gpt-5.6-sol"); err != nil {
			t.Fatalf("seed round %d: %v", round, err)
		}
	}
	for _, modelID := range []string{HarnessDefaultModelID, CodexNativeModelID, KimiNativeModelID, quota.SpeechTranscriptionModelID} {
		var count int
		if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM model_catalog WHERE model_id = ?`, modelID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("model %s seeded %d times", modelID, count)
		}
	}
}

func TestEnsureAuthorizationNeverOverwritesExistingRow(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := t.Context()
	if err := SeedCatalog(ctx, store, "gpt-5.6-sol"); err != nil {
		t.Fatal(err)
	}
	sid := "S-1-5-21-1000"
	if err := store.EnsureAuthorization(ctx, sid, CodexNativeModelID, "provision_default"); err != nil {
		t.Fatal(err)
	}
	authorized, err := store.Authorized(ctx, sid, CodexNativeModelID)
	if err != nil || !authorized {
		t.Fatalf("seeded authorization missing: authorized=%t err=%v", authorized, err)
	}
	// A later administrator revocation must survive provision/repair replays.
	if err := store.SetAuthorization(ctx, sid, CodexNativeModelID, false, "admin_revoke"); err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureAuthorization(ctx, sid, CodexNativeModelID, "provision_default"); err != nil {
		t.Fatal(err)
	}
	authorized, err = store.Authorized(ctx, sid, CodexNativeModelID)
	if err != nil || authorized {
		t.Fatalf("replay overwrote administrator adjustment: authorized=%t err=%v", authorized, err)
	}
}

func TestEnsureAuthorizationRequiresCatalogEntry(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.EnsureAuthorization(t.Context(), "S-1-5-21-1000", "unknown-model", ""); !errors.Is(err, ErrModelNotFound) {
		t.Fatalf("unknown model seeded: %v", err)
	}
}
