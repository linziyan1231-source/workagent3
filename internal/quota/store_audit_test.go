package quota

import (
	"context"
	"path/filepath"
	"testing"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
)

func openAuditedTestStore(t *testing.T) (*Store, *audit.Store) {
	t.Helper()
	store := openTestStore(t)
	auditStore, err := audit.Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { auditStore.Close() })
	store.SetAudit(auditStore)
	return store, auditStore
}

func TestQuotaReserveAndSettleWriteBusinessAuditEvents(t *testing.T) {
	ctx := context.Background()
	store, auditStore := openAuditedTestStore(t)
	payer := "S-1-5-21-100"
	if err := store.SetBudget(ctx, Budget{SID: payer, ModelID: "codex-native", Period: Daily, LimitUnits: 100}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReserveForSID(ctx, payer, ReserveRequest{RunID: "run-audit-1", SID: payer, ModelID: "codex-native", EstimatedUnits: 40}); err != nil {
		t.Fatal(err)
	}
	if err := store.SettleForSID(ctx, payer, SettleRequest{RunID: "run-audit-1", ActualUnits: 12}); err != nil {
		t.Fatal(err)
	}
	// An unchanged settlement replay is not a new business event.
	if err := store.SettleForSID(ctx, payer, SettleRequest{RunID: "run-audit-1", ActualUnits: 12}); err != nil {
		t.Fatal(err)
	}

	events, err := auditStore.List(ctx, contracts.AuditQuery{CorrelationID: "run-audit-1"})
	if err != nil || len(events) != 2 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	byAction := map[string]contracts.AuditEvent{}
	for _, event := range events {
		byAction[event.Action] = event
		if event.Actor != payer || event.Target != "run-audit-1" || event.Result != "success" {
			t.Fatalf("unexpected event: %#v", event)
		}
	}
	if byAction[audit.ActionQuotaReserve].Metadata["model_id"] != "codex-native" || byAction[audit.ActionQuotaReserve].Metadata["estimated_units"] != "40" {
		t.Fatalf("reserve metadata: %#v", byAction[audit.ActionQuotaReserve].Metadata)
	}
	if byAction[audit.ActionQuotaSettle].Metadata["actual_units"] != "12" {
		t.Fatalf("settle metadata: %#v", byAction[audit.ActionQuotaSettle].Metadata)
	}
}

func TestQuotaExceededReserveIsAuditedAsDenied(t *testing.T) {
	ctx := context.Background()
	store, auditStore := openAuditedTestStore(t)
	payer := "S-1-5-21-100"
	if err := store.SetBudget(ctx, Budget{SID: payer, ModelID: "codex-native", Period: Daily, LimitUnits: 10}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reserve(ctx, ReserveRequest{RunID: "run-denied", SID: payer, ModelID: "codex-native", EstimatedUnits: 50}); err == nil {
		t.Fatal("over-limit reserve succeeded")
	}
	events, err := auditStore.List(ctx, contracts.AuditQuery{CorrelationID: "run-denied"})
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	if events[0].Action != audit.ActionQuotaReserve || events[0].Result != "denied" || events[0].Actor != payer {
		t.Fatalf("unexpected denied event: %#v", events[0])
	}
}
