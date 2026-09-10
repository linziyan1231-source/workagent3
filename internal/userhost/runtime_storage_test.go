package userhost

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDisposableCleanupDoesNotFollowLinks(t *testing.T) {
	root := t.TempDir()
	cache := filepath.Join(root, "cache")
	private := filepath.Join(root, "private")
	os.MkdirAll(cache, 0700)
	os.MkdirAll(private, 0700)
	old := time.Now().Add(-30 * 24 * time.Hour)
	for _, path := range []string{filepath.Join(cache, "old"), filepath.Join(private, "secret")} {
		os.WriteFile(path, []byte("keep private"), 0600)
		os.Chtimes(path, old, old)
	}
	os.WriteFile(filepath.Join(cache, "recent"), []byte("recent"), 0600)
	if err := os.Symlink(private, filepath.Join(cache, "link")); err != nil {
		t.Fatal(err)
	}
	cleanRuntimeCache(cache, time.Now().Add(-14*24*time.Hour))
	if _, err := os.Stat(filepath.Join(cache, "old")); !os.IsNotExist(err) {
		t.Fatal("expired cache retained")
	}
	for _, path := range []string{filepath.Join(private, "secret"), filepath.Join(cache, "recent")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal(err)
		}
	}
}
func TestHarnessLogIsBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "harness.log")
	log, err := openHarnessLog(path, 32)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := log.Write([]byte(strings.Repeat("x", 400))); err != nil || n != 400 {
		t.Fatalf("write: %d %v", n, err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 4 {
		t.Fatalf("retention: %d", len(entries))
	}
	for _, entry := range entries {
		info, _ := entry.Info()
		if info.Size() > 32 {
			t.Fatal("oversize log")
		}
	}
}
