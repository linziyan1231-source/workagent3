package modelaccess

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "model-access.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	store.now = func() time.Time { return time.Date(2026, 8, 31, 2, 30, 0, 0, time.UTC) }
	return store
}

func testModel() Model {
	input, output := 1.25, 5.0
	return Model{
		ID: "codex-native", ProviderID: "codex", DisplayName: "Codex",
		Aliases: []string{"codex"}, ContextWindow: 200_000,
		InputPricePerMillion: &input, OutputPricePerMillion: &output, Health: Healthy,
	}
}

func TestCatalogAuthorizationFailsClosed(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	if err := store.UpsertModel(ctx, testModel()); err != nil {
		t.Fatal(err)
	}
	const sid = "S-1-5-21-100"
	models, err := store.ListAuthorized(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].Authorization.Authorized || models[0].Authorization.Reason != "not_granted" {
		t.Fatalf("unexpected default authorization: %#v", models)
	}
	if err := store.SetAuthorization(ctx, sid, testModel().ID, true, ""); err != nil {
		t.Fatal(err)
	}
	authorized, err := store.Authorized(ctx, sid, testModel().ID)
	if err != nil || !authorized {
		t.Fatalf("authorized=%v error=%v", authorized, err)
	}
	models, err = store.ListAuthorized(ctx, sid)
	if err != nil || !models[0].Authorization.Authorized || models[0].Authorization.Reason != "" {
		t.Fatalf("unexpected granted model: %#v error=%v", models, err)
	}
}

func TestAuthorizationRejectsUnknownModel(t *testing.T) {
	store := openTestStore(t)
	err := store.SetAuthorization(context.Background(), "S-1-5-21-100", "missing", true, "")
	if !errors.Is(err, ErrModelNotFound) {
		t.Fatalf("expected missing model error, got %v", err)
	}
}

func TestDownstreamKeyIsScopedAndRevocable(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	model := testModel()
	if err := store.UpsertModel(ctx, model); err != nil {
		t.Fatal(err)
	}
	const sid = "S-1-5-21-100"
	if err := store.SetAuthorization(ctx, sid, model.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	key, err := store.IssueDownstreamKey(ctx, sid, []string{model.ID, model.ID})
	if err != nil {
		t.Fatal(err)
	}
	if key.Token == "" || len(key.ModelIDs) != 1 {
		t.Fatalf("invalid issued key: %#v", key)
	}
	resolvedSID, err := store.AuthorizeDownstreamKey(ctx, key.Token, model.ID)
	if err != nil || resolvedSID != sid {
		t.Fatalf("resolved SID %q: %v", resolvedSID, err)
	}
	if _, err := store.AuthorizeDownstreamKey(ctx, key.Token, "kimi-native"); !errors.Is(err, ErrDownstreamKey) {
		t.Fatalf("key escaped model scope: %v", err)
	}
	if err := store.RevokeDownstreamKey(ctx, sid, key.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AuthorizeDownstreamKey(ctx, key.Token, model.ID); !errors.Is(err, ErrDownstreamKey) {
		t.Fatalf("revoked key remained valid: %v", err)
	}
}

func TestDownstreamKeyRequiresEveryModelGrant(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	if err := store.UpsertModel(ctx, testModel()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.IssueDownstreamKey(ctx, "S-1-5-21-100", []string{"codex-native"}); !errors.Is(err, ErrModelUnauthorized) {
		t.Fatalf("expected unauthorized issue failure, got %v", err)
	}
}
