package employee

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectHarnessProfileReplacesCompletePackageTree(t *testing.T) {
	root := t.TempDir()
	source, destination := filepath.Join(root, "release"), filepath.Join(root, "private", "workagent")
	if err := os.MkdirAll(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(destination, "obsolete.js"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := range 96 {
		path := filepath.Join(source, fmt.Sprintf("package-%d", i), "index.js")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(fmt.Sprint(i)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := projectHarnessProfile(source, destination); err != nil {
		t.Fatal(err)
	}
	for i := range 96 {
		data, err := os.ReadFile(filepath.Join(destination, fmt.Sprintf("package-%d", i), "index.js"))
		if err != nil || string(data) != fmt.Sprint(i) {
			t.Fatalf("package %d incomplete: %q %v", i, data, err)
		}
	}
	if _, err := os.Stat(filepath.Join(destination, "obsolete.js")); !os.IsNotExist(err) {
		t.Fatalf("obsolete file retained: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(destination))
	if err != nil || len(entries) != 1 {
		t.Fatalf("staging or backup retained: %v %v", entries, err)
	}
}

func TestCopyProfileTreeReportsConcurrentCopyFailure(t *testing.T) {
	root := t.TempDir()
	source, destination := filepath.Join(root, "release"), filepath.Join(root, "staging")
	for _, path := range []string{source, destination} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 96 {
		name := fmt.Sprintf("file-%d", i)
		if err := os.WriteFile(filepath.Join(source, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(destination, "file-0"), []byte("collision"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyProfileTree(source, destination); err == nil {
		t.Fatal("copy collision was ignored")
	}
	// Cleanup immediately: no copy worker may still hold destination files open.
	if err := os.RemoveAll(destination); err != nil {
		t.Fatalf("copy workers still active: %v", err)
	}
}

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
