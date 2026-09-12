package skillruntime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReferenceSharesResourcesAndPreservesDisableAndSource(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "original")
	writeSkillPackage(t, source)
	store, err := Open(filepath.Join(root, "catalog.db"), filepath.Join(root, "installed"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	input := Entry{ID: "ref-example", Name: "Example", Version: "1", Enabled: true}
	entry, err := store.Reference(t.Context(), input, source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "live-resource.txt"), []byte("updated"), 0600); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(store.DirectoryFor(entry), "live-resource.txt")); err != nil || string(data) != "updated" {
		t.Fatalf("reference did not expose live resource: %v", err)
	}
	if _, err := store.SetEnabled(t.Context(), entry.ID, false); err != nil {
		t.Fatal(err)
	}
	entry, err = store.Reference(t.Context(), input, source)
	if err != nil || entry.Enabled {
		t.Fatalf("rescan changed disabled state: %v", err)
	}
	if err := store.Remove(t.Context(), entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(source, "SKILL.md")); err != nil {
		t.Fatalf("source was removed: %v", err)
	}
}

func TestReferenceCannotReplaceRealDirectory(t *testing.T) {
	root := t.TempDir()
	link := filepath.Join(root, "existing")
	if err := os.Mkdir(link, 0700); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDirectoryReference(link, root); err == nil {
		t.Fatal("real directory replaced")
	}
}
