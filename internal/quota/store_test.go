package quota

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type authorizationStub struct {
	authorized bool
}

func (a authorizationStub) Authorized(context.Context, string, string) (bool, error) {
	return a.authorized, nil
}

type authorizationCapture struct {
	sid     string
	modelID string
}

func (capture *authorizationCapture) Authorized(_ context.Context, sid, modelID string) (bool, error) {
	capture.sid = sid
	capture.modelID = modelID
	return true, nil
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "quota.db"), authorizationStub{authorized: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	store.now = func() time.Time { return time.Date(2026, 8, 31, 1, 0, 0, 0, time.UTC) }
	return store
}

func TestReserveAndSettleAreIdempotent(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	budget := Budget{SID: "S-1-5-21-100", ModelID: "codex-native", Period: Daily, LimitUnits: 100}
	if err := store.SetBudget(ctx, budget); err != nil {
		t.Fatal(err)
	}
	request := ReserveRequest{RunID: "run-1", SID: budget.SID, ModelID: budget.ModelID, EstimatedUnits: 40}
	first, err := store.Reserve(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Reserve(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("idempotent reserve changed result: %#v != %#v", first, second)
	}
	conflict := request
	conflict.EstimatedUnits++
	if _, err := store.Reserve(ctx, conflict); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected reserve conflict, got %v", err)
	}
	if err := store.Settle(ctx, SettleRequest{RunID: "run-1", ActualUnits: 25}); err != nil {
		t.Fatal(err)
	}
	if err := store.Settle(ctx, SettleRequest{RunID: "run-1", ActualUnits: 25}); err != nil {
		t.Fatal(err)
	}
	if err := store.Settle(ctx, SettleRequest{RunID: "run-1", ActualUnits: 26}); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected settlement conflict, got %v", err)
	}
	usage, err := store.Usage(ctx, budget.SID, budget.ModelID, store.now())
	if err != nil {
		t.Fatal(err)
	}
	if usage.ConsumedUnits != 25 || usage.ReservedUnits != 0 {
		t.Fatalf("unexpected usage: %#v", usage)
	}
}

func TestSpeechPortUsesFixedTranscriptionBucket(t *testing.T) {
	ctx := t.Context()
	const sid = "S-1-5-21-991"
	authorizer := &authorizationCapture{}
	store, err := Open(":memory:", authorizer)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.SetBudget(ctx, Budget{SID: sid, ModelID: SpeechTranscriptionModelID, Period: Daily, LimitUnits: 300}); err != nil {
		t.Fatal(err)
	}
	if err := store.ReserveSpeech(ctx, sid, "speech-run", 60); err != nil {
		t.Fatal(err)
	}
	if authorizer.sid != sid || authorizer.modelID != SpeechTranscriptionModelID {
		t.Fatalf("speech authorization used sid=%q model=%q", authorizer.sid, authorizer.modelID)
	}
	if err := store.SettleSpeech(ctx, "speech-run", 7); err != nil {
		t.Fatal(err)
	}
	usage, err := store.Usage(ctx, sid, SpeechTranscriptionModelID, time.Now())
	if err != nil || usage.ConsumedUnits != 7 || usage.ReservedUnits != 0 {
		t.Fatalf("speech usage=%#v err=%v", usage, err)
	}
}

func TestAuthoritativeSettlementCanExceedEstimateAndBlocksFutureRuns(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	budget := Budget{SID: "S-1-5-21-104", ModelID: "codex-native", Period: Daily, LimitUnits: 50}
	if err := store.SetBudget(ctx, budget); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reserve(ctx, ReserveRequest{
		RunID: "run-over", SID: budget.SID, ModelID: budget.ModelID, EstimatedUnits: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Settle(ctx, SettleRequest{RunID: "run-over", ActualUnits: 60}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reserve(ctx, ReserveRequest{
		RunID: "run-next", SID: budget.SID, ModelID: budget.ModelID, EstimatedUnits: 1,
	}); !errors.Is(err, ErrExceeded) {
		t.Fatalf("expected over-budget admission failure, got %v", err)
	}
}

func TestWeeklyBudgetUsesISOWeekBoundary(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	budget := Budget{SID: "S-1-5-21-105", ModelID: "kimi-native", Period: Weekly, LimitUnits: 10}
	if err := store.SetBudget(ctx, budget); err != nil {
		t.Fatal(err)
	}
	monday := time.Date(2026, 8, 31, 10, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	if _, err := store.Reserve(ctx, ReserveRequest{
		RunID: "week-one", SID: budget.SID, ModelID: budget.ModelID, EstimatedUnits: 10, At: monday,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reserve(ctx, ReserveRequest{
		RunID: "week-two", SID: budget.SID, ModelID: budget.ModelID, EstimatedUnits: 10, At: monday.Add(7 * 24 * time.Hour),
	}); err != nil {
		t.Fatalf("new ISO week should have a fresh budget: %v", err)
	}
}

func TestConcurrentReserveCannotBypassLimit(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	budget := Budget{SID: "S-1-5-21-101", ModelID: "kimi-native", Period: Daily, LimitUnits: 50}
	if err := store.SetBudget(ctx, budget); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	errorsByRun := make(chan error, 2)
	for _, runID := range []string{"run-a", "run-b"} {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := store.Reserve(ctx, ReserveRequest{
				RunID: runID, SID: budget.SID, ModelID: budget.ModelID, EstimatedUnits: 40,
			})
			errorsByRun <- err
		}()
	}
	wait.Wait()
	close(errorsByRun)
	var succeeded, exceeded int
	for err := range errorsByRun {
		if err == nil {
			succeeded++
		} else if errors.Is(err, ErrExceeded) {
			exceeded++
		} else {
			t.Fatalf("unexpected reserve error: %v", err)
		}
	}
	if succeeded != 1 || exceeded != 1 {
		t.Fatalf("expected one success and one rejection, got %d and %d", succeeded, exceeded)
	}
}

func TestReserveFailsClosedForUnauthorizedOrMissingBudget(t *testing.T) {
	ctx := context.Background()
	unauthorized, err := Open(filepath.Join(t.TempDir(), "unauthorized.db"), authorizationStub{authorized: false})
	if err != nil {
		t.Fatal(err)
	}
	defer unauthorized.Close()
	request := ReserveRequest{RunID: "run-1", SID: "S-1-5-21-102", ModelID: "codex-native", EstimatedUnits: 1}
	if _, err := unauthorized.Reserve(ctx, request); !errors.Is(err, ErrModelUnauthorized) {
		t.Fatalf("expected unauthorized error, got %v", err)
	}

	store := openTestStore(t)
	if _, err := store.Reserve(ctx, request); !errors.Is(err, ErrBudgetNotConfigured) {
		t.Fatalf("expected missing budget error, got %v", err)
	}
}
