package skillmarket

import (
	"errors"
	"testing"
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
