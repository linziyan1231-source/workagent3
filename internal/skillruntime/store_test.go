package skillruntime

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInstallListDisableAndRemove(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	writeSkillPackage(t, source)

	store, err := Open(filepath.Join(root, "catalog.db"), filepath.Join(root, "installed"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.now = func() time.Time { return time.UnixMilli(1_700_000_000_000) }

	installed, err := store.Install(ctx, InstallInput{
		Entry: Entry{
			ID:                   "drawing-review",
			Name:                 "Drawing Review",
			Description:          "Reviews drawing packages.",
			Version:              "1.2.3",
			Source:               "user",
			Enabled:              true,
			RequiredMCPServerIDs: []string{"dwg-server"},
		},
		SourceDirectory: source,
	})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.IsAbs(installed.RelativePath) || installed.RelativePath != "drawing-review/drawing-review" {
		t.Fatalf("unexpected relative path %q", installed.RelativePath)
	}
	contents, err := os.ReadFile(filepath.Join(store.RootFor(installed), "drawing-review", "SKILL.md"))
	if err != nil || !strings.Contains(string(contents), "Drawing Review") {
		t.Fatalf("installed skill was not copied: %q, %v", contents, err)
	}

	entries, err := store.List(ctx)
	if err != nil || len(entries) != 1 || entries[0].ID != installed.ID {
		t.Fatalf("unexpected list: %#v, %v", entries, err)
	}
	disabled, err := store.SetEnabled(ctx, installed.ID, false)
	if err != nil || disabled.Enabled {
		t.Fatalf("skill was not disabled: %#v, %v", disabled, err)
	}
	if _, err := store.Install(ctx, InstallInput{Entry: installed, SourceDirectory: source}); err == nil {
		t.Fatal("duplicate install succeeded")
	}

	if err := store.Remove(ctx, installed.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, installed.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed skill remains in catalog: %v", err)
	}
	if _, err := os.Stat(store.RootFor(installed)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("installed skill remains active: %v", err)
	}
	trash, err := os.ReadDir(filepath.Join(root, "installed", ".trash"))
	if err != nil || len(trash) != 1 {
		t.Fatalf("removed skill was not archived: %#v, %v", trash, err)
	}
	if _, err := os.Stat(filepath.Join(source, "SKILL.md")); err != nil {
		t.Fatalf("source package was modified: %v", err)
	}
}

func TestInstallRejectsInvalidPackages(t *testing.T) {
	root := t.TempDir()
	store, err := Open(filepath.Join(root, "catalog.db"), filepath.Join(root, "installed"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	source := filepath.Join(root, "source")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	valid := InstallInput{Entry: Entry{ID: "valid", Name: "Valid", Version: "1", Source: "user", Enabled: true}, SourceDirectory: source}
	if _, err := store.Install(context.Background(), valid); err == nil || !strings.Contains(err.Error(), "SKILL.md") {
		t.Fatalf("missing SKILL.md was accepted: %v", err)
	}

	writeSkillPackage(t, source)
	valid.ID = "unsafe/id"
	if _, err := store.Install(context.Background(), valid); err == nil {
		t.Fatal("unsafe id was accepted")
	}
	valid.ID = "valid"
	valid.SourceDirectory = "relative"
	if _, err := store.Install(context.Background(), valid); err == nil {
		t.Fatal("relative source was accepted")
	}
}

func TestInstallRejectsLinks(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	writeSkillPackage(t, source)
	if err := os.Symlink(filepath.Join(source, "SKILL.md"), filepath.Join(source, "linked.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	store, err := Open(filepath.Join(root, "catalog.db"), filepath.Join(root, "installed"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, err = store.Install(context.Background(), InstallInput{
		Entry:           Entry{ID: "linked", Name: "Linked", Version: "1", Source: "user", Enabled: true},
		SourceDirectory: source,
	})
	if err == nil || !strings.Contains(err.Error(), "reparse point") {
		t.Fatalf("linked package was accepted: %v", err)
	}
}

func TestInstallMarketAtomicallyReplacesOlderMarketVersion(t *testing.T) {
	root := t.TempDir()
	firstSource := filepath.Join(root, "first")
	secondSource := filepath.Join(root, "second")
	writeSkillPackage(t, firstSource)
	writeSkillPackage(t, secondSource)
	if err := os.WriteFile(filepath.Join(secondSource, "references", "guide.md"), []byte("version two"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := Open(filepath.Join(root, "catalog.db"), filepath.Join(root, "installed"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.now = func() time.Time { return time.UnixMilli(1_700_000_000_000) }
	first, err := store.InstallMarket(t.Context(), InstallInput{Entry: Entry{ID: "market-v1", Name: "Drawing Review", Version: "1.0.0", Source: "market", Enabled: true}, SourceDirectory: firstSource})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.InstallMarket(t.Context(), InstallInput{Entry: Entry{ID: "market-v2", Name: "Drawing Review", Version: "2.0.0", Source: "market", Enabled: true}, SourceDirectory: secondSource})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != "market-v2" || second.Version != "2.0.0" {
		t.Fatalf("upgraded entry = %#v", second)
	}
	if _, err := store.Get(t.Context(), first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old market version remains: %v", err)
	}
	contents, err := os.ReadFile(filepath.Join(store.RootFor(second), "drawing-review", "references", "guide.md"))
	if err != nil || string(contents) != "version two" {
		t.Fatalf("upgraded package contents = %q, %v", contents, err)
	}
	trash, err := os.ReadDir(filepath.Join(root, "installed", ".trash"))
	if err != nil || len(trash) != 1 {
		t.Fatalf("previous version was not retained for recovery: %#v, %v", trash, err)
	}
}

func TestExportUserPackageCreatesSingleSkillArchive(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	writeSkillPackage(t, source)
	store, err := Open(filepath.Join(root, "catalog.db"), filepath.Join(root, "installed"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, err = store.Install(t.Context(), InstallInput{Entry: Entry{ID: "drawing-review", Name: "Drawing Review", Description: "Reviews drawings", Version: "1.0.0", Source: "user", Enabled: true}, SourceDirectory: source})
	if err != nil {
		t.Fatal(err)
	}
	entry, archive, err := store.ExportUserPackage(t.Context(), "drawing review")
	if err != nil || entry.ID != "drawing-review" || len(archive) == 0 {
		t.Fatalf("export = %#v, %d bytes, %v", entry, len(archive), err)
	}
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, file := range reader.File {
		if file.Name == "drawing-review/SKILL.md" {
			found = true
		}
	}
	if !found {
		t.Fatalf("exported archive files = %#v", reader.File)
	}
}

func writeSkillPackage(t *testing.T, directory string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(directory, "references"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte("---\nname: drawing-review\ndescription: Reviews drawings\n---\n# Drawing Review\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "references", "guide.md"), []byte("guide"), 0o600); err != nil {
		t.Fatal(err)
	}
}
