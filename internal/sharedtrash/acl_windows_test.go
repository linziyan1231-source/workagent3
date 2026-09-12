//go:build windows

package sharedtrash

import (
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
	"workagent3/internal/contracts"
	"workagent3/internal/winutil"
)

func TestTrashStripsEmployeeACLAndRestoreUsesCurrentMembers(t *testing.T) {
	f := newFixture(t)
	owner, err := winutil.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	oldMember, newMember := "S-1-5-21-11-22-33-1001", "S-1-5-21-11-22-33-1002"
	root := filepath.Join(f.base, "shared", testOwner, testProject)
	f.write(t, testOwner, testProject, "docs/report.txt", "retained")
	if err := winutil.ApplySharedProjectTree(root, owner, []string{oldMember}); err != nil {
		t.Fatal(err)
	}
	entry := f.recycle(t, testOwner, testProject, "docs")
	payload := filepath.Join(f.store.root, testProject, entry.ID, "payload")
	readACL := func(path string) string {
		t.Helper()
		sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		return sd.String()
	}
	for _, name := range []string{payload, filepath.Join(payload, "report.txt"), filepath.Join(f.store.root, testProject, entry.ID, "metadata.json")} {
		acl := readACL(name)
		if strings.Contains(acl, oldMember) || strings.Contains(acl, owner) || !strings.Contains(acl, ";;;SY)") || !strings.Contains(acl, ";;;BA)") {
			t.Fatalf("trash ACL still grants employee access: %s", acl)
		}
	}
	if err := winutil.ApplySharedProjectTree(root, owner, []string{newMember}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "restore", EntryID: entry.ID}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{filepath.Join(root, "docs"), filepath.Join(root, "docs", "report.txt")} {
		acl := readACL(name)
		if strings.Contains(acl, oldMember) || !strings.Contains(acl, newMember) || strings.ReplaceAll(acl, ";OICI;", ";;") != strings.ReplaceAll(readACL(root), ";OICI;", ";;") {
			t.Fatalf("restored ACL is stale: %s", acl)
		}
	}
}
