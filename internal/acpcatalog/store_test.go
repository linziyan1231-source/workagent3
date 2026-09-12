package acpcatalog

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestApprovedVersionsPersistWithoutFallback(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "pkg"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pkg", "agent.exe"), []byte("fixture executable"), 0600); err != nil {
		t.Fatal(err)
	}
	row := Entry{ID: "approved", Label: "Approved", Revision: "v1", PackageRef: "pkg", Command: "agent.exe", BillingModelID: "fixed", Enabled: true}
	second := row
	second.Revision = "v2"
	manifest := filepath.Join(root, "catalog.json")
	state := filepath.Join(root, "state.json")
	data, _ := json.Marshal([]Entry{row, second})
	if err := os.WriteFile(manifest, data, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := Open(manifest, state)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Select("approved", Selection{Revision: "v2", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if frozen, err := store.Resolve("approved", "v1"); err != nil || frozen.BillingModelID != "fixed" {
		t.Fatal("frozen revision unavailable")
	}
	store, err = Open(manifest, state)
	if err != nil {
		t.Fatal(err)
	}
	if current, err := store.Resolve("approved", ""); err != nil || current.Revision != "v2" {
		t.Fatal("selection not persisted")
	}
	if err = store.Select("approved", Selection{Revision: "v2", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Resolve("approved", "v1"); !errors.Is(err, ErrDisabled) {
		t.Fatal("disable did not cover frozen sessions")
	}
	if err = store.Select("approved", Selection{Revision: "unknown", Enabled: true}); !errors.Is(err, ErrNotFound) {
		t.Fatal("unapproved version accepted")
	}
	row.Command = "../../outside.exe"
	data, _ = json.Marshal([]Entry{row})
	_ = os.WriteFile(manifest, data, 0600)
	if _, err = Open(manifest, state); err == nil {
		t.Fatal("escaped executable accepted")
	}
}

func TestCredentialEnvironmentCannotReplaceProcessConfiguration(t *testing.T) {
	for _, env := range []string{"PATH", "NODE_OPTIONS", "WORKAGENT_PLATFORM_TOKEN", "DSH_HOME"} {
		row := Entry{ID: "a", Label: "A", Revision: "v1", PackageRef: "pkg", Command: "run.exe", BillingModelID: "fixed", CredentialFields: []CredentialField{{ID: "key", Label: "Key", Environment: env}}}
		if Validate(row) == nil {
			t.Errorf("accepted reserved environment %s", env)
		}
	}
}
