package managedskills

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/skillruntime"
)

func TestSyncInstallsAndUpgradesWhilePreservingEmployeeState(t *testing.T) {
	release := t.TempDir()
	writeReleaseSkill(t, release, "wiki", "version one")
	writeManifest(t, release, "1.0.0")
	runtimeRoot := t.TempDir()
	skills, err := skillruntime.Open(filepath.Join(runtimeRoot, "skills.db"), filepath.Join(runtimeRoot, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	defer skills.Close()
	if err := Sync(context.Background(), release, skills); err != nil {
		t.Fatal(err)
	}
	if _, err := skills.SetEnabled(context.Background(), "wiki", false); err != nil {
		t.Fatal(err)
	}
	writeReleaseSkill(t, release, "wiki", "version two")
	writeManifest(t, release, "2.0.0")
	if err := Sync(context.Background(), release, skills); err != nil {
		t.Fatal(err)
	}
	entry, err := skills.Get(context.Background(), "wiki")
	if err != nil || entry.Version != "2.0.0" || entry.Enabled {
		t.Fatalf("upgraded skill = %#v, %v", entry, err)
	}
	contents, err := os.ReadFile(filepath.Join(skills.DirectoryFor(entry), "version.txt"))
	if err != nil || string(contents) != "version two" {
		t.Fatalf("release contents = %q, %v", contents, err)
	}
}

func TestReleaseCatalogInstallsAdaptedDWGAndWikiSkills(t *testing.T) {
	release, err := filepath.Abs(filepath.Join("..", "..", "release", "managed-skills"))
	if err != nil {
		t.Fatal(err)
	}
	runtimeRoot := t.TempDir()
	skills, err := skillruntime.Open(filepath.Join(runtimeRoot, "skills.db"), filepath.Join(runtimeRoot, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	defer skills.Close()
	if err := Sync(t.Context(), release, skills); err != nil {
		t.Fatal(err)
	}
	entries, err := skills.List(t.Context())
	if err != nil || len(entries) != 7 {
		t.Fatalf("release entries = %#v, %v", entries, err)
	}
	for _, entry := range entries {
		if _, err := os.Stat(filepath.Join(skills.DirectoryFor(entry), "SKILL.md")); err != nil {
			t.Fatalf("%s missing installed document: %v", entry.ID, err)
		}
		if entry.ID == "dwg-quantity-surveyor" && (len(entry.RequiredMCPServerIDs) != 1 || entry.RequiredMCPServerIDs[0] != "dwg-quantity-surveyor") {
			t.Fatalf("DWG dependency = %#v", entry.RequiredMCPServerIDs)
		}
	}
	err = filepath.Walk(release, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return walkErr
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		lower := strings.ToLower(string(contents))
		for _, legacy := range []string{"aionui", "aioncore", "workagent2", "aionui_helper_bin"} {
			if strings.Contains(lower, legacy) {
				t.Fatalf("release asset %s retains legacy dependency %q", path, legacy)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func writeReleaseSkill(t *testing.T, root, name, version string) {
	t.Helper()
	directory := filepath.Join(root, name)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte("---\nname: wiki\ndescription: Wiki workflows\n---\n# Wiki\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "version.txt"), []byte(version), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeManifest(t *testing.T, root, version string) {
	t.Helper()
	manifest := `{"schemaVersion":1,"skills":[{"id":"wiki","name":"Wiki","description":"Wiki workflows","version":"` + version + `","relativePath":"wiki","enabledByDefault":true,"requiredMcpServerIds":[]}]}`
	if err := os.WriteFile(filepath.Join(root, "managed-skills.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
}
