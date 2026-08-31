package audit

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

func TestAuditStoreIsAppendOnlyQueryableAndBounded(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.now = func() time.Time { return time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC) }
	ctx := context.Background()
	first, err := store.Record(ctx, contracts.AuditInput{Actor: "alice", Target: "/api/settings/client", Action: "PUT /api/settings/client", Result: "success", CorrelationID: "corr-one"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "bob", Target: "/api/runtime/v1/sessions", Action: "POST /api/runtime/", Result: "denied", CorrelationID: "corr-two"}); err != nil {
		t.Fatal(err)
	}
	items, err := store.List(ctx, contracts.AuditQuery{Actor: "alice", Limit: 10})
	if err != nil || len(items) != 1 || items[0].ID != first.ID || !items[0].OccurredAt.Equal(store.now()) {
		t.Fatalf("events=%#v err=%v", items, err)
	}
	byCorrelation, err := store.List(ctx, contracts.AuditQuery{CorrelationID: "corr-two"})
	if err != nil || len(byCorrelation) != 1 || byCorrelation[0].Actor != "bob" {
		t.Fatalf("correlation events=%#v err=%v", byCorrelation, err)
	}
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "alice", Action: "auth.login", Result: "success", CorrelationID: strings.Repeat("x", 129)}); err == nil {
		t.Fatal("oversized correlation ID was accepted")
	}
}
