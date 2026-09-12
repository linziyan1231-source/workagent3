//go:build windows

package sharedtrash

import (
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestUnreadableMetadataPreservesUnknownAndRecentWhileKnownTTLContinues(t *testing.T) {
	// SSH administrator processes can inherit enabled backup privilege, which
	// lets Go's backup-semantics reads bypass the fixture's sharing denial.
	// Disable it only in this test process to exercise an actually unreadable
	// journal, then restore the process's previous privilege state.
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	var luid windows.LUID
	privilege, _ := windows.UTF16PtrFromString("SeBackupPrivilege")
	if err := windows.LookupPrivilegeValue(nil, privilege, &luid); err != nil {
		t.Fatal(err)
	}
	desired := windows.Tokenprivileges{PrivilegeCount: 1}
	desired.Privileges[0].Luid = luid
	var previous windows.Tokenprivileges
	var length uint32
	if err := windows.AdjustTokenPrivileges(token, false, &desired, uint32(unsafe.Sizeof(previous)), &previous, &length); err != nil {
		t.Fatal(err)
	}
	defer windows.AdjustTokenPrivileges(token, false, &previous, 0, nil, nil)
	f := newFixture(t)
	f.write(t, testOwner, testProject, "expired.txt", "expired")
	expired := f.recycle(t, testOwner, testProject, "expired.txt")
	f.write(t, testOtherOwner, testOtherProject, "unreadable.txt", "locked")
	locked := f.recycle(t, testOtherOwner, testOtherProject, "unreadable.txt")
	f.now = f.now.Add(6 * 24 * time.Hour)
	f.write(t, testOwner, testProject, "recent.txt", "recent")
	recent := f.recycle(t, testOwner, testProject, "recent.txt")
	f.now = f.now.Add(2 * 24 * time.Hour)
	metadataPath := filepath.Join(f.store.root, testOtherProject, locked.ID, "metadata.json")
	name, err := windows.UTF16PtrFromString(metadataPath)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if handle != windows.InvalidHandle {
			windows.CloseHandle(handle)
		}
	}()
	if _, err := os.ReadFile(metadataPath); err == nil {
		t.Fatal("fixture must deny metadata reads")
	}
	// Known bytes alone exceed this limit; with an unreadable record, FIFO
	// order/capacity are incomplete and must not evict the recent entry.
	f.store.limit = 1
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.store.root, testProject, expired.ID, "payload")); !os.IsNotExist(err) {
		t.Fatalf("known expired file retained: %v", err)
	}
	for project, id := range map[string]string{testOtherProject: locked.ID, testProject: recent.ID} {
		if _, err := os.Stat(filepath.Join(f.store.root, project, id, "payload")); err != nil {
			t.Fatalf("unknown/recent file removed: %v", err)
		}
	}
	windows.CloseHandle(handle)
	handle = windows.InvalidHandle
	f.store.limit = LimitBytes
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.store.root, testOtherProject, locked.ID, "payload")); !os.IsNotExist(err) {
		t.Fatalf("unlocked expired file not retried: %v", err)
	}
	if got := f.list(t, testOwner, testProject); len(got.Entries) != 1 || got.Entries[0].ID != recent.ID {
		t.Fatalf("recent entry lost: %#v", got)
	}
}
