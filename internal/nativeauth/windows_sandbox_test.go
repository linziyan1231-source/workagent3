package nativeauth

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsSandboxInitialization(t *testing.T) {
	root := t.TempDir()
	if err := EnsureWindowsSandbox(root); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "native", "codex", "config.toml")
	original := "model = \"example\"\n"
	if err := writePrivate(path, []byte(original)); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := EnsureWindowsSandbox(root); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(got), original) || strings.Count(string(got), "[windows]") != 1 || !strings.Contains(string(got), `sandbox = "unelevated"`) {
		t.Fatalf("unexpected configuration: %s", got)
	}
	backup, _ := os.ReadFile(path + ".before-windows-sandbox")
	if string(backup) != original {
		t.Fatal("original configuration was not retained")
	}
	for _, configured := range []string{"[windows]\nsandbox = \"elevated\"\n", "windows.sandbox = \"elevated\"\n"} {
		if err := writePrivate(path, []byte(configured)); err != nil {
			t.Fatal(err)
		}
		if err := EnsureWindowsSandbox(root); err != nil {
			t.Fatal(err)
		}
		got, _ = os.ReadFile(path)
		if string(got) != configured {
			t.Fatal("existing Windows configuration changed")
		}
	}
}
