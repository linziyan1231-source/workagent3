package quota

import (
	"context"
	"errors"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

type gatewayCatalog struct{}

func (gatewayCatalog) Authorized(context.Context, string, string) (bool, error) { return true, nil }
func (gatewayCatalog) ListAuthorized(context.Context, string) ([]contracts.AuthorizedModel, error) {
	return []contracts.AuthorizedModel{
		{Model: contracts.Model{ID: "codex-native", ProviderID: "codex"}},
		{Model: contracts.Model{ID: "harness-default", ProviderID: "harness"}},
		{Model: contracts.Model{ID: "gpt-test", ProviderID: "codex", Aliases: []string{"upstream-test"}}},
		{Model: contracts.Model{ID: "gpt-other", ProviderID: "codex"}},
		{Model: contracts.Model{ID: "kimi-native", ProviderID: "kimi"}},
		{Model: contracts.Model{ID: "kimi-test", ProviderID: "kimi"}},
	}, nil
}

func accountingStore(t *testing.T) (*Store, string) {
	t.Helper()
	s, err := Open(":memory:", gatewayCatalog{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	s.UseGatewayAccounting()
	at := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return at }
	sid := "S-1-5-21-100"
	for _, id := range []string{"codex-native", "harness-default", "gpt-test", "gpt-other", "kimi-native", "kimi-test"} {
		if err := s.SetBudget(t.Context(), Budget{sid, id, Daily, 10000}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.MarkGatewayDrained(t.Context(), at); err != nil {
		t.Fatal(err)
	}
	return s, sid
}

func TestGatewayAccountingIncludesUnreservedHistoryOnce(t *testing.T) {
	s, sid := accountingStore(t)
	r := gatewayRecord("history", sid, "upstream-test", 13540, s.now().Add(-time.Minute))
	for i := 0; i < 2; i++ {
		if err := s.RecordGatewayUsage(t.Context(), r); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"codex-native", "harness-default", "gpt-test"} {
		u, err := s.Usage(t.Context(), sid, id, s.now())
		if err != nil || u.ConsumedUnits != 13540 {
			t.Fatalf("%s usage=%+v error=%v", id, u, err)
		}
	}
	_, err := s.Reserve(t.Context(), ReserveRequest{RunID: "blocked", SID: sid, ModelID: "gpt-other", EstimatedUnits: 1})
	if !errors.Is(err, ErrExceeded) {
		t.Fatalf("switching models bypassed shared cap: %v", err)
	}
	u, err := s.Usage(t.Context(), sid, "kimi-test", s.now())
	if err != nil || u.ConsumedUnits != 0 {
		t.Fatalf("unrelated provider charged: %+v %v", u, err)
	}
}

func TestGatewayAccountingWaitsForLateUsageAndPreservesCancelledConsumption(t *testing.T) {
	s, sid := accountingStore(t)
	ctx := t.Context()
	r := ReserveRequest{RunID: "chat", SID: sid, ModelID: "gpt-test", EstimatedUnits: 1024}
	if _, err := s.Reserve(ctx, r); err != nil {
		t.Fatal(err)
	}
	at := s.now().Add(time.Second)
	s.now = func() time.Time { return at }
	if err := s.Settle(ctx, SettleRequest{RunID: r.RunID, ActualUnits: 0}); err != nil {
		t.Fatal(err)
	}
	if err := s.Settle(ctx, SettleRequest{RunID: r.RunID, ActualUnits: 0}); err != nil {
		t.Fatal(err)
	}
	r.RunID = "next"
	if _, err := s.Reserve(ctx, r); !errors.Is(err, ErrUsagePending) {
		t.Fatalf("late usage was bypassed: %v", err)
	}
	usage := gatewayRecord("cancelled-after-usage", sid, "gpt-test", 4000, at)
	usage.Failed = true
	if err := s.RecordGatewayUsage(ctx, usage); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkGatewayDrained(ctx, at.Add(time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	u, err := s.Usage(ctx, sid, "codex-native", at)
	if err != nil || u.ConsumedUnits != 4000 || u.ReservedUnits != 0 {
		t.Fatalf("real usage lost/doubled: %+v %v", u, err)
	}
	if err := s.AdjustBudget(ctx, sid, "codex-native", "temporary", 4000, at); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, r); !errors.Is(err, ErrExceeded) {
		t.Fatalf("temporary cap not enforced: %v", err)
	}
	if err := s.AdjustBudget(ctx, sid, "codex-native", "restore", 0, at); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, r); err != nil {
		t.Fatalf("restored cap did not recover: %v", err)
	}
}

func TestGatewayAccountingFreshnessAndConcurrentHolds(t *testing.T) {
	s, sid := accountingStore(t)
	ctx := t.Context()
	if err := s.AdjustBudget(ctx, sid, "codex-native", "permanent", 1500, s.now()); err != nil {
		t.Fatal(err)
	}
	r := ReserveRequest{RunID: "first", SID: sid, ModelID: "gpt-test", EstimatedUnits: 1000}
	if _, err := s.Reserve(ctx, r); err != nil {
		t.Fatal(err)
	}
	r.RunID = "concurrent"
	r.ModelID = "gpt-other"
	if _, err := s.Reserve(ctx, r); !errors.Is(err, ErrExceeded) {
		t.Fatalf("concurrent holds bypassed cap: %v", err)
	}
	at := s.now().Add(11 * time.Second)
	s.now = func() time.Time { return at }
	r.ModelID = "kimi-test"
	if _, err := s.Reserve(ctx, r); !errors.Is(err, ErrUsageStale) {
		t.Fatalf("stale consumer allowed spending: %v", err)
	}
}

func TestGatewayAccountingEngineAdjustmentsDoNotRequireEditingAnotherEngine(t *testing.T) {
	s, sid := accountingStore(t)
	ctx := t.Context()
	if err := s.AdjustBudget(ctx, sid, "harness-default", "temporary", 0, s.now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, ReserveRequest{RunID: "codex", SID: sid, ModelID: "gpt-test", EstimatedUnits: 1, Engine: "codex"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, ReserveRequest{RunID: "harness", SID: sid, ModelID: "gpt-test", EstimatedUnits: 1, Engine: "harness"}); !errors.Is(err, ErrExceeded) {
		t.Fatalf("Harness cap bypassed: %v", err)
	}
}

func TestGatewayAccountingUTCRolloverKeepsActiveHolds(t *testing.T) {
	s, sid := accountingStore(t)
	ctx := t.Context()
	at := time.Date(2026, 9, 13, 23, 59, 59, 0, time.UTC)
	s.now = func() time.Time { return at }
	if err := s.SetBudget(ctx, Budget{sid, "codex-native", Weekly, 10000}); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkGatewayDrained(ctx, at); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordGatewayUsage(ctx, gatewayRecord("old", sid, "gpt-test", 3000, at)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, ReserveRequest{RunID: "active", SID: sid, ModelID: "gpt-test", EstimatedUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	at = at.Add(time.Second)
	u, err := s.Usage(ctx, sid, "codex-native", at)
	if err != nil || u.ConsumedUnits != 0 || u.ReservedUnits != 1000 || u.PeriodKey != "2026-W38" {
		t.Fatalf("rollover=%+v %v", u, err)
	}
}

func TestGatewayAccountingSharedPayerIsChargedWithoutChargingOwnerTwice(t *testing.T) {
	s, payer := accountingStore(t)
	ctx := t.Context()
	owner := "S-1-5-21-200"
	if err := s.SetBudget(ctx, Budget{owner, "gpt-test", Daily, 10000}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, ReserveRequest{RunID: "shared", SID: payer, ModelID: "gpt-test", EstimatedUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO quota_gateway_run_owners(run_id,sid) VALUES('shared',?)`, owner); err != nil {
		t.Fatal(err)
	}
	at := s.now().Add(time.Second)
	s.now = func() time.Time { return at }
	if err := s.Settle(ctx, SettleRequest{RunID: "shared", ActualUnits: 1000}); !errors.Is(err, ErrUsagePending) {
		t.Fatalf("shared settled before drain: %v", err)
	}
	if err := s.RecordGatewayUsage(ctx, gatewayRecord("shared-request", owner, "gpt-test", 2000, at)); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkGatewayDrained(ctx, at.Add(time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if err := s.Settle(ctx, SettleRequest{RunID: "shared", ActualUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	if err := s.Settle(ctx, SettleRequest{RunID: "shared", ActualUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	for sid, want := range map[string]int64{payer: 2000, owner: 0} {
		u, err := s.Usage(ctx, sid, "gpt-test", at)
		if err != nil || u.ConsumedUnits != want {
			t.Fatalf("sid=%s usage=%+v err=%v", sid, u, err)
		}
		g, err := s.GatewayUsage(ctx, sid, at)
		if err != nil || g.DailyTokens != want {
			t.Fatalf("sid=%s gateway=%+v err=%v", sid, g, err)
		}
	}
}
