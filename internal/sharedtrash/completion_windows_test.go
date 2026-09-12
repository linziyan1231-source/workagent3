//go:build windows

package sharedtrash

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
	"workagent3/internal/winutil"
)

// A scanner or an already-open handle can temporarily deny rename/delete on
// Windows. Use a real sharing violation instead of adding production test hooks.
func holdWithoutDeleteSharing(t *testing.T, path string) func() {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	close := func() {
		if !closed {
			windows.CloseHandle(handle)
			closed = true
		}
	}
	t.Cleanup(close)
	return close
}

func TestCommittedRecycleDefersLockedMetadataFinalization(t *testing.T) {
	f := newFixture(t)
	f.write(t, testOwner, testProject, "report.txt", "retained")
	entry := f.recycle(t, testOwner, testProject, "report.txt")
	directory := filepath.Join(f.store.root, testProject, entry.ID)
	record, err := readMetadata(directory, testProject, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Phase = "recycling"
	if err := writeMetadata(directory, record); err != nil {
		t.Fatal(err)
	}
	unlock := holdWithoutDeleteSharing(t, filepath.Join(directory, "metadata.json"))
	completed := finishRecycle(directory, record)
	if completed.ID != entry.ID {
		t.Fatal("committed deletion was not returned")
	}
	pending, err := readMetadata(directory, testProject, entry.ID)
	if err != nil || pending.Phase != "recycling" {
		t.Fatalf("pending journal = %#v, %v", pending, err)
	}
	if got := f.list(t, testOwner, testProject); len(got.Entries) != 1 || got.UsedBytes != entry.Size {
		t.Fatalf("committed bytes disappeared from pool: %#v", got)
	}
	unlock()
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	ready, err := readMetadata(directory, testProject, entry.ID)
	if err != nil || ready.Phase != "" {
		t.Fatalf("retry = %#v, %v", ready, err)
	}
}

func TestCommittedRestoreDefersLockedJournalCleanup(t *testing.T) {
	f := newFixture(t)
	source := f.write(t, testOwner, testProject, "report.txt", "retained")
	entry := f.recycle(t, testOwner, testProject, "report.txt")
	directory := filepath.Join(f.store.root, testProject, entry.ID)
	record, err := readMetadata(directory, testProject, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Phase = "restoring"
	if err := writeMetadata(directory, record); err != nil {
		t.Fatal(err)
	}
	if err := renameNoReplace(filepath.Join(directory, "payload"), source); err != nil {
		t.Fatal(err)
	}
	if err := winutil.RestoreSharedTrashTree(source, filepath.Dir(source)); err != nil {
		t.Fatal(err)
	}
	unlock := holdWithoutDeleteSharing(t, filepath.Join(directory, "metadata.json"))
	completed := finishRestore(storedEntry{metadata: record, directory: directory})
	if completed.ID != entry.ID {
		t.Fatal("committed restore was not returned")
	}
	if content, _ := os.ReadFile(source); string(content) != "retained" {
		t.Fatal("restored bytes changed")
	}
	unlock()
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("restore journal not retried: %v", err)
	}
}

func TestPurgeKeepsJournalAndAccountsLockedPayloadUntilRetry(t *testing.T) {
	f := newFixture(t)
	f.write(t, testOwner, testProject, "report.txt", "retained")
	entry := f.recycle(t, testOwner, testProject, "report.txt")
	directory := filepath.Join(f.store.root, testProject, entry.ID)
	item, err := f.store.find(testProject, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	unlock := holdWithoutDeleteSharing(t, filepath.Join(directory, "payload"))
	if err := removeEntry(item); err == nil {
		t.Fatal("locked purge unexpectedly completed")
	}
	pending, err := readMetadata(directory, testProject, entry.ID)
	if err != nil || pending.Phase != "purging" {
		t.Fatalf("purge journal lost: %#v, %v", pending, err)
	}
	listing, err := f.store.list(testProject)
	if err != nil || len(listing.Entries) != 0 || listing.UsedBytes != entry.Size {
		t.Fatalf("locked payload accounting = %#v, %v", listing, err)
	}
	unlock()
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("purge was not retried: %v", err)
	}
}

func TestCommittedPurgeDefersLockedJournalCleanup(t *testing.T) {
	f := newFixture(t)
	f.write(t, testOwner, testProject, "report.txt", "retained")
	entry := f.recycle(t, testOwner, testProject, "report.txt")
	directory := filepath.Join(f.store.root, testProject, entry.ID)
	record, err := readMetadata(directory, testProject, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Phase = "purging"
	if err := writeMetadata(directory, record); err != nil {
		t.Fatal(err)
	}
	unlock := holdWithoutDeleteSharing(t, filepath.Join(directory, "metadata.json"))
	if err := finishPurge(directory); err != nil {
		t.Fatalf("committed purge reported failure: %v", err)
	}
	if _, err := os.Stat(filepath.Join(directory, "payload")); !os.IsNotExist(err) {
		t.Fatalf("payload remains: %v", err)
	}
	unlock()
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("purge journal not retried: %v", err)
	}
}
