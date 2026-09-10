package quota

import (
	"errors"
	"math"
	"testing"
	"time"
	"workagent3/internal/contracts"
)

const testSID = "S-1-5-21-200"

func TestDollarHistoryBoundariesDeduplicationAndFrozenPrices(t *testing.T) {
	s, err := OpenRecorder(t.TempDir() + "/quota.db")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	from := time.Date(2026, 9, 10, 1, 30, 0, 0, time.UTC)
	for i, id := range []string{"start", "middle", "end"} {
		r := contracts.GatewayUsageRecord{RequestID: id, SID: testSID, Model: "gpt", InputTokens: 1000, CachedTokens: 400, OutputTokens: 100, TotalTokens: 1100, OccurredAt: from.Add(time.Duration(i) * time.Minute)}
		if err = s.RecordGatewayUsage(t.Context(), r); err != nil {
			t.Fatal(err)
		}
		if err = s.RecordGatewayUsage(t.Context(), r); err != nil {
			t.Fatal(err)
		}
	}
	rate := contracts.BillingRate{SID: testSID, Pool: "codex", Model: "gpt", Mode: "tokens", Input: 5, Cache: 0.5, Output: 30}
	if err = s.SyncDollarBilling(t.Context(), nil, []contracts.BillingRate{rate}); err != nil {
		t.Fatal(err)
	}
	rate.Input = 100
	if err = s.SyncDollarBilling(t.Context(), nil, []contracts.BillingRate{rate}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.DollarUsage(t.Context(), testSID, from, from.Add(2*time.Minute))
	if err != nil || len(rows) != 1 || rows[0].Requests != 2 || rows[0].Estimated != 2 || math.Abs(rows[0].USD-0.0124) > 1e-9 {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	rows, err = s.DollarUsage(t.Context(), "S-1-5-21-999", from, from.Add(time.Hour))
	if err != nil || len(rows) != 0 {
		t.Fatalf("cross-user rows=%+v err=%v", rows, err)
	}
}

func TestDollarAdmissionSharesCodexAndChecksBothWindows(t *testing.T) {
	s, err := OpenRecorder(t.TempDir() + "/quota.db")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	at := time.Now().UTC()
	for _, b := range []contracts.DollarBudget{
		{SID: testSID, Pool: "codex", DailyLimitUSD: 40, WeeklyLimitUSD: 80, DailyUSD: 1, WeeklyUSD: 80, UpdatedAt: at},
		{SID: testSID, Pool: "kimi", DailyLimitUSD: 10, WeeklyLimitUSD: 20, DailyUSD: 2, WeeklyUSD: 3, UpdatedAt: at},
	} {
		if err = s.SyncDollarBilling(t.Context(), []contracts.DollarBudget{b}, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, engine := range []string{"codex", "harness", "kimi"} {
		tx, _ := s.db.BeginTx(t.Context(), nil)
		checked, err := checkDollarAdmission(t.Context(), tx, ReserveRequest{SID: testSID, Engine: engine, At: at})
		tx.Rollback()
		if !checked || (engine != "kimi" && !errors.Is(err, ErrExceeded)) || (engine == "kimi" && err != nil) {
			t.Fatalf("%s %v %v", engine, checked, err)
		}
	}
	tx, _ := s.db.BeginTx(t.Context(), nil)
	_, err = checkDollarAdmission(t.Context(), tx, ReserveRequest{SID: testSID, Engine: "kimi", At: at.Add(time.Minute)})
	tx.Rollback()
	if !errors.Is(err, ErrUsageStale) {
		t.Fatal(err)
	}
}
