package quota

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTemporaryBudgetExpiresAndPreservesUsage(t *testing.T) {
	for _, period := range []Period{Daily, Weekly} {
		t.Run(string(period), func(t *testing.T) {
			s := openTestStore(t)
			ctx := context.Background()
			at := s.now()
			sid := "S-1-5-21-100"
			if err := s.SetBudget(ctx, Budget{sid, "model", period, 100}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Reserve(ctx, ReserveRequest{RunID: "first", SID: sid, ModelID: "model", EstimatedUnits: 80, At: at}); err != nil {
				t.Fatal(err)
			}
			if err := s.AdjustBudget(ctx, sid, "model", "temporary", 200, at); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Reserve(ctx, ReserveRequest{RunID: "extra", SID: sid, ModelID: "model", EstimatedUnits: 100, At: at}); err != nil {
				t.Fatal(err)
			}
			b, err := s.ManagedBudgets(ctx, sid, at)
			if err != nil || !b[0].Temporary || b[0].ReservedUnits != 180 || b[0].BaseLimitUnits != 100 {
				t.Fatalf("budgets=%+v err=%v", b, err)
			}
			next := b[0].ResetsAt
			if next.Sub(at) > 7*24*time.Hour {
				t.Fatal("invalid reset")
			}
			if _, err := s.Reserve(ctx, ReserveRequest{RunID: "next", SID: sid, ModelID: "model", EstimatedUnits: 101, At: next}); !errors.Is(err, ErrExceeded) {
				t.Fatalf("next-cycle enforcement: %v", err)
			}
			b, err = s.ManagedBudgets(ctx, sid, next)
			if err != nil || b[0].Temporary || b[0].LimitUnits != 100 || b[0].ReservedUnits != 0 {
				t.Fatalf("next=%+v err=%v", b, err)
			}
			if err := s.AdjustBudget(ctx, sid, "model", "permanent", 300, at); err != nil {
				t.Fatal(err)
			}
			b, err = s.ManagedBudgets(ctx, sid, at)
			if err != nil || b[0].Temporary || b[0].LimitUnits != 300 || b[0].ReservedUnits != 180 {
				t.Fatalf("permanent=%+v err=%v", b, err)
			}
			if err := s.EnsureBudget(ctx, Budget{sid, "model", period, 100}); err != nil {
				t.Fatal(err)
			}
			b, _ = s.ManagedBudgets(ctx, sid, next)
			if b[0].LimitUnits != 300 {
				t.Fatal("repair overwrote permanent budget")
			}
		})
	}
}

func TestTemporaryZeroAndRestoreDoNotResetConsumption(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	sid := "S-1-5-21-100"
	if err := s.SetBudget(ctx, Budget{sid, "model", Daily, 100}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, ReserveRequest{RunID: "used", SID: sid, ModelID: "model", EstimatedUnits: 40}); err != nil {
		t.Fatal(err)
	}
	if err := s.Settle(ctx, SettleRequest{RunID: "used", ActualUnits: 40}); err != nil {
		t.Fatal(err)
	}
	if err := s.AdjustBudget(ctx, sid, "model", "temporary", 0, s.now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, ReserveRequest{RunID: "blocked", SID: sid, ModelID: "model", EstimatedUnits: 1}); !errors.Is(err, ErrExceeded) {
		t.Fatalf("zero quota allowed a run: %v", err)
	}
	if err := s.AdjustBudget(ctx, sid, "model", "restore", 0, s.now()); err != nil {
		t.Fatal(err)
	}
	budgets, err := s.ManagedBudgets(ctx, sid, s.now())
	if err != nil || budgets[0].Temporary || budgets[0].ConsumedUnits != 40 || budgets[0].LimitUnits != 100 {
		t.Fatalf("restore: %+v %v", budgets, err)
	}
	if _, err := s.Reserve(ctx, ReserveRequest{RunID: "remaining", SID: sid, ModelID: "model", EstimatedUnits: 60}); err != nil {
		t.Fatal(err)
	}
}
