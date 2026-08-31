package employee

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectHarnessProfileCopiesFilesAndInternalLinks(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "released-profile")
	if err := os.MkdirAll(filepath.Join(source, "zzz-packages", "runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "zzz-packages", "runtime", "index.js"), []byte("runtime"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("zzz-packages", "runtime"), filepath.Join(source, "aaa-runtime")); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	destination := filepath.Join(root, "private", "dsh-home", "profiles", "workagent")
	if err := projectHarnessProfile(source, destination); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(filepath.Join(destination, "aaa-runtime", "index.js"))
	if err != nil || string(payload) != "runtime" {
		t.Fatalf("projected profile link is unusable: %q %v", payload, err)
	}
}

func TestProjectHarnessProfileRejectsEscapingLink(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "released-profile")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "secret"), filepath.Join(source, "escape")); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	err := projectHarnessProfile(source, filepath.Join(root, "private", "workagent"))
	if err == nil {
		t.Fatal("escaping profile symlink was accepted")
	}
}
