package notifications

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

func TestStoreScopesReceiptsAndGlobalNotificationsBySID(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	ctx := context.Background()
	aliceSID := "S-1-5-21-1001"
	bobSID := "S-1-5-21-1002"

	alice, err := store.Publish(ctx, contracts.NotificationInput{TargetSID: aliceSID, Kind: "task", Title: "Done", Message: "Your task completed", DeepLink: "/conversation/one"})
	if err != nil {
		t.Fatal(err)
	}
	global, err := store.Publish(ctx, contracts.NotificationInput{TargetSID: GlobalTarget, Kind: "maintenance", Message: "Maintenance starts soon"})
	if err != nil {
		t.Fatal(err)
	}

	aliceItems, err := store.List(ctx, aliceSID, 20)
	if err != nil || len(aliceItems) != 2 {
		t.Fatalf("alice list=%#v err=%v", aliceItems, err)
	}
	bobItems, err := store.List(ctx, bobSID, 20)
	if err != nil || len(bobItems) != 1 || bobItems[0].ID != global.ID {
		t.Fatalf("bob list=%#v err=%v", bobItems, err)
	}
	if err := store.MarkRead(ctx, aliceSID, alice.ID); err != nil {
		t.Fatal(err)
	}
	aliceItems, _ = store.List(ctx, aliceSID, 20)
	var readAt *time.Time
	for _, item := range aliceItems {
		if item.ID == alice.ID {
			readAt = item.ReadAt
		}
	}
	if readAt == nil {
		t.Fatalf("read receipt missing: %#v", aliceItems)
	}
	if err := store.Acknowledge(ctx, aliceSID, global.ID); err != nil {
		t.Fatal(err)
	}
	aliceItems, _ = store.List(ctx, aliceSID, 20)
	if len(aliceItems) != 1 || aliceItems[0].ID != alice.ID {
		t.Fatalf("acknowledged item was not hidden: %#v", aliceItems)
	}
	bobItems, _ = store.List(ctx, bobSID, 20)
	if len(bobItems) != 1 || bobItems[0].ID != global.ID {
		t.Fatalf("alice receipt affected bob: %#v", bobItems)
	}
	if err := store.Acknowledge(ctx, bobSID, alice.ID); !errors.Is(err, contracts.ErrNotificationNotFound) {
		t.Fatalf("foreign receipt error=%v", err)
	}
}

func TestStoreValidatesDeepLinksExpiryAndSignalsSubscribers(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	sid := "S-1-5-21-1001"
	events, cancel, err := store.Subscribe(sid)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	for _, deepLink := range []string{"https://evil.example", "//evil.example", "/%2f%2fevil.example", `/\\evil.example`} {
		if _, err := store.Publish(context.Background(), contracts.NotificationInput{TargetSID: sid, Kind: "bad", Message: "bad", DeepLink: deepLink}); err == nil {
			t.Fatalf("unsafe deep link was accepted: %q", deepLink)
		}
	}
	expired := now.Add(-time.Second)
	if _, err := store.Publish(context.Background(), contracts.NotificationInput{TargetSID: sid, Kind: "task", Message: "expired", ExpiresAt: &expired}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-events:
	default:
		t.Fatal("subscriber was not signaled")
	}
	items, err := store.List(context.Background(), sid, 20)
	if err != nil || len(items) != 0 {
		t.Fatalf("expired list=%#v err=%v", items, err)
	}
}
