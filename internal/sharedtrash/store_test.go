package sharedtrash

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

const testOwner = "S-1-5-21-1000"
const testOtherOwner = "S-1-5-21-2000"
const testProject = "project_1234567890"
const testOtherProject = "project_0987654321"

type fixture struct {
	store *Store
	base  string
	now   time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	base := t.TempDir()
	for _, pair := range [][2]string{{testOwner, testProject}, {testOtherOwner, testOtherProject}} {
		if err := os.MkdirAll(filepath.Join(base, "shared", pair[0], pair[1]), 0700); err != nil {
			t.Fatal(err)
		}
	}
	store, err := New(base)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{store: store, base: base, now: time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)}
	store.now = func() time.Time { return f.now }
	return f
}

func (f *fixture) write(t *testing.T, owner, project, path, content string) string {
	t.Helper()
	name := filepath.Join(f.base, "shared", owner, project, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return name
}

func (f *fixture) recycle(t *testing.T, owner, project, path string) contracts.SharedTrashEntry {
	t.Helper()
	value, err := f.store.Operate(t.Context(), project, contracts.SharedTrashRequest{OwnerSID: owner, Operation: "recycle", Path: path})
	if err != nil {
		t.Fatal(err)
	}
	return value.(contracts.SharedTrashEntry)
}

func (f *fixture) list(t *testing.T, owner, project string) contracts.SharedTrashList {
	t.Helper()
	value, err := f.store.Operate(t.Context(), project, contracts.SharedTrashRequest{OwnerSID: owner, Operation: "list"})
	if err != nil {
		t.Fatal(err)
	}
	return value.(contracts.SharedTrashList)
}

func TestRecycleRestoreAndRestartPreserveDirectoriesAndScope(t *testing.T) {
	f := newFixture(t)
	f.write(t, testOwner, testProject, "docs/nested/report.txt", "hello")
	f.write(t, testOtherOwner, testOtherProject, "private.txt", "other")
	entry := f.recycle(t, testOwner, testProject, "docs")
	other := f.recycle(t, testOtherOwner, testOtherProject, "private.txt")
	if entry.Kind != "directory" || entry.Size != 5 {
		t.Fatalf("entry = %#v", entry)
	}
	if _, err := os.Stat(filepath.Join(f.base, "shared", testOwner, testProject, "docs")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source remains: %v", err)
	}
	reopened, err := New(f.base)
	if err != nil {
		t.Fatal(err)
	}
	reopened.now = f.store.now
	f.store = reopened
	listing := f.list(t, testOwner, testProject)
	if len(listing.Entries) != 1 || listing.Entries[0].ID != entry.ID || listing.UsedBytes != 10 || listing.ProjectUsedBytes != 5 || listing.LimitBytes != LimitBytes || listing.RetentionDays != 7 {
		t.Fatalf("list = %#v", listing)
	}
	if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "restore", EntryID: other.ID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-project restore = %v", err)
	}
	if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "restore", EntryID: entry.ID}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(f.base, "shared", testOwner, testProject, "docs", "nested", "report.txt"))
	if err != nil || string(content) != "hello" {
		t.Fatalf("restored = %q, %v", content, err)
	}
	if got := f.list(t, testOwner, testProject); len(got.Entries) != 0 || got.UsedBytes != 5 {
		t.Fatalf("list after restore = %#v", got)
	}
}

func TestRestoreConflictRetainsTrashAndRecreatesMissingParents(t *testing.T) {
	f := newFixture(t)
	name := f.write(t, testOwner, testProject, "docs/report.txt", "original")
	entry := f.recycle(t, testOwner, testProject, "docs/report.txt")
	f.write(t, testOwner, testProject, "docs/report.txt", "replacement")
	request := contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "restore", EntryID: entry.ID}
	if _, err := f.store.Operate(t.Context(), testProject, request); !errors.Is(err, ErrExists) {
		t.Fatalf("conflict = %v", err)
	}
	if content, _ := os.ReadFile(name); string(content) != "replacement" {
		t.Fatalf("replacement changed: %q", content)
	}
	if len(f.list(t, testOwner, testProject).Entries) != 1 {
		t.Fatal("conflict lost trash")
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Dir(name)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Operate(t.Context(), testProject, request); err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(name); string(content) != "original" {
		t.Fatalf("restored = %q", content)
	}
}

func TestGlobalFIFOAndSevenDayExpiration(t *testing.T) {
	f := newFixture(t)
	f.store.limit = 10
	f.write(t, testOwner, testProject, "old.txt", "123456")
	old := f.recycle(t, testOwner, testProject, "old.txt")
	f.now = f.now.Add(time.Minute)
	f.write(t, testOtherOwner, testOtherProject, "new.txt", "abcdef")
	newer := f.recycle(t, testOtherOwner, testOtherProject, "new.txt")
	if got := f.list(t, testOwner, testProject); len(got.Entries) != 0 || got.UsedBytes != 6 {
		t.Fatalf("global eviction = %#v", got)
	}
	if _, err := os.Stat(filepath.Join(f.store.root, testProject, old.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old payload remains: %v", err)
	}
	f.now = newer.ExpiresAt.Add(-time.Nanosecond)
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, testOtherOwner, testOtherProject).Entries) != 1 {
		t.Fatal("expired early")
	}
	f.now = newer.ExpiresAt
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := f.list(t, testOtherOwner, testOtherProject); len(got.Entries) != 0 || got.UsedBytes != 0 {
		t.Fatalf("expiration = %#v", got)
	}
}

func TestLegacyImportAcrossOfflineOwnersGetsFullRetention(t *testing.T) {
	f := newFixture(t)
	legacyName := "1600000000000-12345678-1234-1234-1234-123456789012-old.txt"
	f.write(t, testOwner, testProject, ".workagent-trash/"+legacyName, "history")
	f.write(t, testOtherOwner, testOtherProject, ".workagent-trash/unclassified-name.bin", "legacy")
	personal := filepath.Join(f.base, testOwner, "workspace", ".workagent-trash", "keep.txt")
	if err := os.MkdirAll(filepath.Dir(personal), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(personal, []byte("personal"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	listing := f.list(t, testOwner, testProject)
	if len(listing.Entries) != 1 {
		t.Fatalf("legacy = %#v", listing)
	}
	entry := listing.Entries[0]
	if !entry.Legacy || entry.Path != "old.txt" || entry.LegacyDeletedAt == nil || !entry.DeletedAt.Equal(f.now) || !entry.ExpiresAt.Equal(f.now.Add(retention)) {
		t.Fatalf("legacy = %#v", entry)
	}
	if got := f.list(t, testOtherOwner, testOtherProject); len(got.Entries) != 1 || got.Entries[0].Path != "unclassified-name.bin" || !got.Entries[0].Legacy {
		t.Fatalf("unknown legacy name = %#v", got)
	}
	if content, _ := os.ReadFile(personal); string(content) != "personal" {
		t.Fatal("personal trash changed")
	}
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(f.list(t, testOwner, testProject).Entries) != 1 {
		t.Fatal("legacy imported twice")
	}
}

func TestRejectEscapesAndPreserveUnknownMetadata(t *testing.T) {
	f := newFixture(t)
	f.write(t, testOwner, testProject, "safe.txt", "safe")
	for _, path := range []string{"", "../safe.txt", "C:/Windows/file", "/absolute", "\\\\server\\share", "folder/../safe.txt", ".workagent-trash/x", "a/.workagent/config", "shared://" + testOtherProject + "/safe.txt"} {
		if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "recycle", Path: path}); !errors.Is(err, ErrInvalid) {
			t.Errorf("path %q = %v", path, err)
		}
	}
	entry := f.recycle(t, testOwner, testProject, "safe.txt")
	directory := filepath.Join(f.store.root, testProject, entry.ID)
	name := filepath.Join(directory, "metadata.json")
	if err := os.WriteFile(name, []byte(`{"version":999}`), 0600); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(10 * 24 * time.Hour)
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(filepath.Join(directory, "payload")); string(content) != "safe" {
		t.Fatal("unknown record deleted")
	}
}

func TestReparsePayloadAndRestoreParentNeverFollowExternalPath(t *testing.T) {
	f := newFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(f.base, "shared", testOwner, testProject, "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "recycle", Path: "linked"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("reparse recycle = %v", err)
	}
	f.write(t, testOwner, testProject, "restore/secret.txt", "original")
	entry := f.recycle(t, testOwner, testProject, "restore/secret.txt")
	parent := filepath.Join(f.base, "shared", testOwner, testProject, "restore")
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "restore", EntryID: entry.ID}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("reparse restore = %v", err)
	}
	if content, _ := os.ReadFile(filepath.Join(outside, "secret.txt")); string(content) != "secret" {
		t.Fatal("external content changed")
	}
}

func TestConcurrentProjectDeletionsShareOneCapacity(t *testing.T) {
	f := newFixture(t)
	f.store.limit = 25
	var wg sync.WaitGroup
	errCh := make(chan error, 20)
	for i := 0; i < 20; i++ {
		name := strings.Repeat("x", i+1) + ".txt"
		f.write(t, testOwner, testProject, name, "12345")
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.store.Operate(context.Background(), testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "recycle", Path: name})
			errCh <- err
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	got := f.list(t, testOwner, testProject)
	if len(got.Entries) != 5 || got.UsedBytes != 25 {
		t.Fatalf("capacity after concurrent writes = %#v", got)
	}
}

func TestTrashFollowsProjectOwnershipTransfer(t *testing.T) {
	f := newFixture(t)
	f.write(t, testOwner, testProject, "report.txt", "retained")
	entry := f.recycle(t, testOwner, testProject, "report.txt")
	oldRoot := filepath.Join(f.base, "shared", testOwner, testProject)
	newRoot := filepath.Join(f.base, "shared", testOtherOwner, testProject)
	if err := os.Rename(oldRoot, newRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Operate(t.Context(), testProject, contracts.SharedTrashRequest{OwnerSID: testOtherOwner, Operation: "restore", EntryID: entry.ID}); err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(filepath.Join(newRoot, "report.txt")); string(content) != "retained" {
		t.Fatalf("transferred restore = %q", content)
	}
}

func TestPermanentDeletionPreservesUnknownFilesBesideManagedPayload(t *testing.T) {
	f := newFixture(t)
	f.write(t, testOwner, testProject, "report.txt", "retained")
	entry := f.recycle(t, testOwner, testProject, "report.txt")
	directory := filepath.Join(f.store.root, testProject, entry.ID)
	if err := os.WriteFile(filepath.Join(directory, "manual-note.txt"), []byte("unknown"), 0600); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(10 * 24 * time.Hour)
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(directory, "manual-note.txt")); err != nil {
		t.Fatalf("unknown removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(directory, "payload")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("known expired payload was retained: %v", err)
	}
}

func TestCommittedRecycleSucceedsWhenCleanupContextExpires(t *testing.T) {
	f := newFixture(t)
	source := f.write(t, testOwner, testProject, "report.txt", "retained")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	clockReads := 0
	f.store.now = func() time.Time {
		clockReads++
		if clockReads == 2 {
			cancel()
		}
		return f.now
	}
	value, err := f.store.Operate(ctx, testProject, contracts.SharedTrashRequest{OwnerSID: testOwner, Operation: "recycle", Path: "report.txt"})
	if err != nil {
		t.Fatalf("committed recycle reported failure: %v", err)
	}
	entry := value.(contracts.SharedTrashEntry)
	if _, err := os.Stat(source); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source was not recycled: %v", err)
	}
	if content, _ := os.ReadFile(filepath.Join(f.store.root, testProject, entry.ID, "payload")); string(content) != "retained" {
		t.Fatal("committed bytes lost")
	}
	f.store.now = func() time.Time { return f.now }
	f.now = entry.ExpiresAt
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := f.list(t, testOwner, testProject); len(got.Entries) != 0 {
		t.Fatalf("deferred cleanup was not retried: %#v", got)
	}
}

func TestInterruptedMetadataInsideEntryDoesNotBlockRecovery(t *testing.T) {
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
	unknown := filepath.Join(directory, "metadata-interrupted.tmp")
	if err := os.WriteFile(unknown, []byte(`{"partial":`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	got := f.list(t, testOwner, testProject)
	if len(got.Entries) != 1 || got.Entries[0].ID != entry.ID {
		t.Fatalf("valid metadata blocked by unknown temp: %#v", got)
	}
	if content, _ := os.ReadFile(unknown); string(content) != `{"partial":` {
		t.Fatal("unknown temporary file was deleted")
	}
}

func TestSameTimestampFIFOUsesPersistedInsertionOrder(t *testing.T) {
	f := newFixture(t)
	f.store.limit = 20
	f.write(t, testOwner, testProject, "first.txt", "123456")
	first := f.recycle(t, testOwner, testProject, "first.txt")
	f.write(t, testOtherOwner, testOtherProject, "second.txt", "123456")
	second := f.recycle(t, testOtherOwner, testOtherProject, "second.txt")
	reopened, err := New(f.base)
	if err != nil {
		t.Fatal(err)
	}
	reopened.now, reopened.limit = f.store.now, 12
	f.store = reopened
	f.write(t, testOwner, testProject, "third.txt", "123456")
	third := f.recycle(t, testOwner, testProject, "third.txt")
	if !first.DeletedAt.Equal(second.DeletedAt) || !second.DeletedAt.Equal(third.DeletedAt) {
		t.Fatal("test timestamps differ")
	}
	got := f.list(t, testOwner, testProject)
	if len(got.Entries) != 1 || got.Entries[0].ID != third.ID || got.UsedBytes != 12 {
		t.Fatalf("FIFO after restart = %#v", got)
	}
	if got := f.list(t, testOtherOwner, testOtherProject); len(got.Entries) != 1 || got.Entries[0].ID != second.ID {
		t.Fatalf("newer other-project entry evicted: %#v", got)
	}
}

func TestRenameNoReplacePreservesConcurrentDestination(t *testing.T) {
	root := t.TempDir()
	source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
	if err := os.WriteFile(source, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("concurrent"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := renameNoReplace(source, target); !errors.Is(err, ErrExists) {
		t.Fatalf("rename = %v", err)
	}
	if content, _ := os.ReadFile(source); string(content) != "original" {
		t.Fatal("source lost on conflict")
	}
	if content, _ := os.ReadFile(target); string(content) != "concurrent" {
		t.Fatal("destination overwritten")
	}
}

func TestRestartCompletesInterruptedRecycleAndRestore(t *testing.T) {
	for _, phase := range []string{"recycling-before-move", "recycling-after-move", "restoring-after-move"} {
		t.Run(phase, func(t *testing.T) {
			f := newFixture(t)
			source := f.write(t, testOwner, testProject, "report.txt", "retained")
			entry := f.recycle(t, testOwner, testProject, "report.txt")
			directory := filepath.Join(f.store.root, testProject, entry.ID)
			record, err := readMetadata(directory, testProject, entry.ID)
			if err != nil {
				t.Fatal(err)
			}
			record.Phase = strings.Split(phase, "-")[0]
			if err := writeMetadata(directory, record); err != nil {
				t.Fatal(err)
			}
			if phase != "recycling-after-move" {
				if err := renameNoReplace(filepath.Join(directory, "payload"), source); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(filepath.Dir(directory), ".metadata-interrupted.tmp"), []byte(`{"partial":`), 0600); err != nil {
				t.Fatal(err)
			}
			reopened, err := New(f.base)
			if err != nil {
				t.Fatal(err)
			}
			reopened.now = f.store.now
			f.store = reopened
			listing := f.list(t, testOwner, testProject)
			if phase == "recycling-after-move" {
				if len(listing.Entries) != 1 || listing.Entries[0].ID != entry.ID {
					t.Fatalf("pending payload not recovered: %#v", listing)
				}
			} else {
				if len(listing.Entries) != 0 {
					t.Fatalf("empty journal retained: %#v", listing)
				}
				if content, _ := os.ReadFile(source); string(content) != "retained" {
					t.Fatal("restored bytes lost")
				}
				if _, err := os.Stat(directory); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("empty record remains: %v", err)
				}
			}
		})
	}
}
