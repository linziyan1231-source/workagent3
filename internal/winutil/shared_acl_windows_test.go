//go:build windows

package winutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSharedACLPoliciesApplyAndVerifyExactTree(t *testing.T) {
	ownerSID, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	memberSID := "S-1-5-21-111111111-222222222-333333333-4444"
	ownerRoot := filepath.Join(t.TempDir(), "shared", ownerSID)
	projectRoot := filepath.Join(ownerRoot, "project_1234567890")
	if err := os.MkdirAll(projectRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, "brief.txt"), []byte("brief"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ApplySharedOwnerRoot(ownerRoot, ownerSID, []string{memberSID}); err != nil {
		t.Fatal(err)
	}
	if err := ApplySharedProjectTree(projectRoot, ownerSID, []string{memberSID}); err != nil {
		t.Fatal(err)
	}
}

func TestSharedACLRejectsReparseRoot(t *testing.T) {
	target := filepath.Join(t.TempDir(), "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create Windows symlink: %v", err)
	}
	ownerSID, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	if err := ApplySharedOwnerRoot(link, ownerSID, nil); err == nil {
		t.Fatal("reparse-point shared root was accepted")
	}
}

func TestSharedRootTraversePreservesUnrelatedACLs(t *testing.T) {
	root := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	employeeSID := "S-1-5-21-111111111-222222222-333333333-4444"
	if err := setExactSharedRootTraverse(root, employeeSID); err != nil {
		t.Fatal(err)
	}
}
