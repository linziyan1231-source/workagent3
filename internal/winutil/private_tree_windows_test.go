//go:build windows

package winutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsurePrivateTreeAppliesVerifiedInheritableACL(t *testing.T) {
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "employee")
	if err := EnsurePrivateTree(root, sid); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(root, "workspace")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(child); err != nil {
		t.Fatal(err)
	}
}
