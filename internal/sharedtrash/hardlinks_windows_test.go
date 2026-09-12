//go:build windows

package sharedtrash

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
	"workagent3/internal/contracts"
	"workagent3/internal/winutil"
)

func trashTestACL(t *testing.T, path string) string {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	return sd.String()
}

func TestSharedTrashRejectsProjectHardlinkWithoutChangingExternalACL(t *testing.T) {
	f := newFixture(t)
	outside := filepath.Join(f.base, "external.txt")
	if err := os.WriteFile(outside, []byte("outside content"), 0600); err != nil {
		t.Fatal(err)
	}
	projectRoot := filepath.Join(f.base, "shared", testOwner, testProject)
	insideRoot := filepath.Join(projectRoot, "docs")
	if err := os.Mkdir(insideRoot, 0700); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(insideRoot, "alias.txt")
	if err := os.Link(outside, inside); err != nil {
		t.Fatal(err)
	}
	externalACL, rootACL := trashTestACL(t, outside), trashTestACL(t, insideRoot)
	for _, relative := range []string{"docs/alias.txt", "docs"} {
		if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "recycle", Path: relative}); err == nil {
			t.Fatalf("hardlink recycle accepted: %s", relative)
		}
	}
	if err := winutil.ProtectSharedTrashTree(insideRoot); err == nil {
		t.Fatal("ACL protection accepted hardlink")
	}
	if err := winutil.RestoreSharedTrashTree(insideRoot, projectRoot); err == nil {
		t.Fatal("ACL restoration accepted hardlink")
	}
	if got := trashTestACL(t, outside); got != externalACL {
		t.Fatalf("external ACL changed: %s", got)
	}
	if got := trashTestACL(t, insideRoot); got != rootACL {
		t.Fatal("preflight changed the source directory ACL")
	}
	for _, name := range []string{outside, inside} {
		if content, _ := os.ReadFile(name); string(content) != "outside content" {
			t.Fatalf("hardlink bytes changed: %s", name)
		}
	}
}

func TestRestoreAndPurgeRejectPayloadHardlinks(t *testing.T) {
	f := newFixture(t)
	f.write(t, testOwner, testProject, "report.txt", "retained")
	entry := f.recycle(t, testOwner, testProject, "report.txt")
	item, err := f.store.find(testProject, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(item.directory, "payload")
	outside := filepath.Join(f.base, "external-alias.txt")
	if err := os.Link(payload, outside); err != nil {
		t.Fatal(err)
	}
	externalACL := trashTestACL(t, outside)
	for _, operation := range []string{"restore", "purge"} {
		if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: operation, EntryID: entry.ID}); err == nil {
			t.Fatalf("hardlinked payload accepted for %s", operation)
		}
	}
	if err := removeEntry(item); err == nil {
		t.Fatal("hardlinked payload accepted by retention")
	}
	if err := finishPurge(item.directory); err == nil {
		t.Fatal("hardlinked payload accepted by purge recovery")
	}
	if got := trashTestACL(t, outside); got != externalACL {
		t.Fatalf("external ACL changed: %s", got)
	}
	for _, name := range []string{payload, outside} {
		if content, _ := os.ReadFile(name); string(content) != "retained" {
			t.Fatalf("hardlink bytes changed: %s", name)
		}
	}
}
