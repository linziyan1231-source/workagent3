package skillmarket

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

func TestReviewGatesMarketVisibility(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	entry, err := store.Publish(t.Context(), Entry{
		ID: "skill-1", Name: "quantity-surveyor", Description: "Take off quantities", Version: "1.0.0",
		PublisherUsername: "alice", PublisherDisplayName: "Alice", ObjectKey: "objects/skill-1.zip",
		ArchiveDigest: "digest-reference", ArchiveBytes: 128,
	})
	if err != nil {
		t.Fatal(err)
	}
	if entry.Status != Draft {
		t.Fatalf("status = %s", entry.Status)
	}
	visible, err := store.ListApproved(t.Context(), "alice")
	if err != nil || len(visible) != 0 {
		t.Fatalf("draft was visible: %#v, %v", visible, err)
	}
	if _, err := store.Review(t.Context(), entry.ID, Approved); err != nil {
		t.Fatal(err)
	}
	visible, err = store.ListApproved(t.Context(), "alice")
	if err != nil || len(visible) != 1 || !visible[0].CanDelete {
		t.Fatalf("approved entry: %#v, %v", visible, err)
	}
	visible, _ = store.ListApproved(t.Context(), "bob")
	if visible[0].CanDelete {
		t.Fatal("unrelated viewer can delete market entry")
	}
}

func TestApprovedPackageVerifiesArchiveBoundaryAndDigest(t *testing.T) {
	root := t.TempDir()
	archive := []byte("verified archive")
	digest := sha256.Sum256(archive)
	if err := os.MkdirAll(filepath.Join(root, "objects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "objects", "skill.zip"), archive, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenWithArchiveRoot(filepath.Join(t.TempDir(), "market.db"), root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	entry, err := store.Publish(t.Context(), Entry{
		ID: "verified", Name: "Verified", Description: "Verified skill", Version: "1.0.0",
		PublisherUsername: "alice", ObjectKey: "objects/skill.zip", ArchiveDigest: hex.EncodeToString(digest[:]), ArchiveBytes: int64(len(archive)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Review(t.Context(), entry.ID, Approved); err != nil {
		t.Fatal(err)
	}
	pack, err := store.ApprovedPackage(t.Context(), entry.ID)
	if err != nil || string(pack.Archive) != string(archive) {
		t.Fatalf("approved package = %#v, %v", pack, err)
	}
	if err := os.WriteFile(filepath.Join(root, "objects", "skill.zip"), []byte("tampered archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApprovedPackage(t.Context(), entry.ID); err == nil {
		t.Fatal("tampered package was accepted")
	}
}

func TestPublishPackageAndDeleteRetainRecoverableArchive(t *testing.T) {
	root := t.TempDir()
	store, err := OpenWithArchiveRoot(filepath.Join(t.TempDir(), "market.db"), root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.now = func() time.Time { return time.UnixMilli(1_700_000_000_000) }
	entry, err := store.PublishPackage(t.Context(), contracts.SkillMarketPublishInput{
		ID: "published", Name: "Published", Description: "Published skill", Version: "1.0.0", PublisherUsername: "alice",
	}, []byte("archive"))
	if err != nil || entry.ID != "published" {
		t.Fatalf("published entry = %#v, %v", entry, err)
	}
	if err := store.Delete(t.Context(), entry.ID, "alice", false); err != nil {
		t.Fatal(err)
	}
	trash, err := os.ReadDir(filepath.Join(root, ".trash"))
	if err != nil || len(trash) != 1 {
		t.Fatalf("deleted archive was not retained: %#v, %v", trash, err)
	}
}

func TestDeleteEnforcesPublisher(t *testing.T) {
	store, _ := Open(":memory:")
	defer store.Close()
	entry, err := store.Publish(t.Context(), Entry{ID: "skill-2", Name: "wiki", Description: "Wiki", Version: "2.0.0", PublisherUsername: "alice", ObjectKey: "objects/skill-2.zip", ArchiveDigest: "digest", ArchiveBytes: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(t.Context(), entry.ID, "bob", false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete returned %v", err)
	}
	if err := store.Delete(t.Context(), entry.ID, "alice", false); err != nil {
		t.Fatal(err)
	}
}
