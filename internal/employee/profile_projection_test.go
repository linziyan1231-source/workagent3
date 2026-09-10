package employee

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeReleasedProfile(t *testing.T, root, version string) string {
	t.Helper()
	path := filepath.Join(root, version)
	if err := os.MkdirAll(filepath.Join(path, "node_modules", "package"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"package.json": "{\"version\":\"" + version + "\"}", "cordis.patch.yml": "[]", "node_modules/package/index.js": version} {
		if err := os.WriteFile(filepath.Join(path, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}
func TestProfileReferenceUpgradeKeepsPrivateDataAndRollback(t *testing.T) {
	root := t.TempDir()
	first, second := makeReleasedProfile(t, root, "v1"), makeReleasedProfile(t, root, "v2")
	destination := filepath.Join(root, "employee", "profile")
	if err := projectHarnessProfile(first, destination); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"cordis.patch.yml": "private patch", "personal-plugin.json": "private settings"} {
		if err := os.WriteFile(filepath.Join(destination, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, release := range []string{second, first} {
		if err := projectHarnessProfile(release, destination); err != nil {
			t.Fatal(err)
		}
		target, err := filepath.EvalSymlinks(filepath.Join(destination, "node_modules", "package", "index.js"))
		expected, expectedErr := filepath.EvalSymlinks(filepath.Join(release, "node_modules", "package", "index.js"))
		if err != nil || expectedErr != nil || !strings.EqualFold(target, expected) {
			t.Fatalf("software is not referenced: %s %v", target, err)
		}
		data, _ := os.ReadFile(filepath.Join(destination, "cordis.patch.yml"))
		if string(data) != "private patch" {
			t.Fatal("private patch replaced")
		}
		data, _ = os.ReadFile(filepath.Join(destination, "personal-plugin.json"))
		if string(data) != "private settings" {
			t.Fatal("personal data removed")
		}
	}
}
func TestProfileReferenceRefusesUnidentifiedSoftwareAndCustomManifest(t *testing.T) {
	root := t.TempDir()
	source := makeReleasedProfile(t, root, "release")
	destination := filepath.Join(root, "employee")
	if err := os.MkdirAll(filepath.Join(destination, "node_modules"), 0700); err != nil {
		t.Fatal(err)
	}
	personal := filepath.Join(destination, "node_modules", "private.txt")
	if err := os.WriteFile(personal, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := projectHarnessProfile(source, destination); err == nil {
		t.Fatal("unidentified directory accepted")
	}
	if data, _ := os.ReadFile(personal); string(data) != "data" {
		t.Fatal("data lost")
	}
	fresh := filepath.Join(root, "fresh")
	if err := projectHarnessProfile(source, fresh); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fresh, "package.json"), []byte(`{"private":"plugin"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := projectHarnessProfile(source, fresh); err == nil {
		t.Fatal("custom manifest overwritten")
	}
}

func TestProfileReferenceDoesNotFollowPrivateConfigLinks(t *testing.T) {
	root := t.TempDir()
	source := makeReleasedProfile(t, root, "release")
	private := filepath.Join(root, "employee")
	if err := os.MkdirAll(private, 0700); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(root, "other.json")
	if err := os.WriteFile(other, []byte("private data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(private, "package.json")); err != nil {
		t.Fatal(err)
	}
	if err := projectHarnessProfile(source, private); err == nil {
		t.Fatal("linked private manifest accepted")
	}
	if data, _ := os.ReadFile(other); string(data) != "private data" {
		t.Fatal("another file was modified")
	}
	link := filepath.Join(root, "redirect")
	if err := os.Symlink(private, link); err != nil {
		t.Fatal(err)
	}
	if err := projectHarnessProfile(source, filepath.Join(link, "profile")); err == nil {
		t.Fatal("linked ancestor accepted")
	}
}
