package settings

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestStoreKeepsSettingsPrivateToSID(t *testing.T) {
	data, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	ctx := t.Context()
	if err := data.Put(ctx, "S-1-5-21-1", map[string]json.RawMessage{"acp.promptTimeout": json.RawMessage(`120`)}); err != nil {
		t.Fatal(err)
	}
	got, err := data.Get(ctx, "S-1-5-21-1", []string{"acp.promptTimeout"})
	if err != nil || string(got["acp.promptTimeout"]) != "120" {
		t.Fatalf("unexpected setting: %s, %v", got["acp.promptTimeout"], err)
	}
	other, err := data.Get(ctx, "S-1-5-21-2", []string{"acp.promptTimeout"})
	if err != nil || len(other) != 0 {
		t.Fatalf("setting leaked to another SID: %#v, %v", other, err)
	}
	if err := data.Put(ctx, "S-1-5-21-1", map[string]json.RawMessage{"acp.promptTimeout": json.RawMessage(`null`)}); err != nil {
		t.Fatal(err)
	}
	got, _ = data.Get(ctx, "S-1-5-21-1", []string{"acp.promptTimeout"})
	if len(got) != 0 {
		t.Fatalf("setting was not deleted: %#v", got)
	}
}

func TestStoreRejectsKeysOwnedByOtherModules(t *testing.T) {
	data, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	for _, key := range []string{"mcp.config", "tools.speechToText", "tools.imageGenerationModel", "google.config"} {
		err := data.Put(t.Context(), "S-1-5-21-1", map[string]json.RawMessage{key: json.RawMessage(`{}`)})
		if !errors.Is(err, ErrUnsupportedKey) {
			t.Fatalf("%s returned %v", key, err)
		}
	}
}
