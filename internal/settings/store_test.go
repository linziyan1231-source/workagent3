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

func TestStorePersistsRendererAppearanceWithoutCrossingModuleBoundaries(t *testing.T) {
	data, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	values := map[string]json.RawMessage{
		"theme.activeId":       json.RawMessage(`"light"`),
		"theme.userThemes":     json.RawMessage(`[]`),
		"ui.fontSize.chat":     json.RawMessage(`14`),
		"ui.fontSize.markdown": json.RawMessage(`13`),
		"ui.fontSize.code":     json.RawMessage(`12`),
	}
	if err := data.Put(t.Context(), "S-1-5-21-1", values); err != nil {
		t.Fatal(err)
	}
	stored, err := data.Get(t.Context(), "S-1-5-21-1", []string{"theme.activeId", "theme.userThemes", "ui.fontSize.chat", "ui.fontSize.markdown", "ui.fontSize.code"})
	if err != nil || len(stored) != len(values) {
		t.Fatalf("appearance settings = %#v, %v", stored, err)
	}
}
