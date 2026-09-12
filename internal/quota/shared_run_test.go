package quota

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
	"workagent3/internal/contracts"
)

func TestSharedAdmissionAtomicIdentityAndConcurrentReplay(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	const owner = "S-1-5-21-1"
	const payer = "S-1-5-21-2"
	if err := s.SetBudget(ctx, Budget{SID: payer, ModelID: "model", Period: Daily, LimitUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	r := contracts.SharedRunQuotaRequest{RunID: "run", OwnerSID: owner, PayerSID: payer, ModelID: "model", Engine: "codex", EstimatedUnits: 100}
	if _, err := s.db.Exec(`CREATE TRIGGER fail_auth BEFORE INSERT ON quota_run_authorizations BEGIN SELECT RAISE(ABORT,'test failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := s.ReserveSharedRun(ctx, r); err == nil {
		t.Fatal("expected authorization insert failure")
	}
	if _, found, err := reservationByRun(ctx, s.db, r.RunID); err != nil || found {
		t.Fatalf("partial admission remains: %v %v", found, err)
	}
	if _, err := s.db.Exec(`DROP TRIGGER fail_auth`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- s.ReserveSharedRun(ctx, r) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	usage, err := s.Usage(ctx, payer, "model", time.Time{})
	if err != nil || usage.ReservedUnits != 100 {
		t.Fatalf("replayed budget=%+v %v", usage, err)
	}
	for _, changed := range []contracts.SharedRunQuotaRequest{
		{RunID: r.RunID, OwnerSID: payer, PayerSID: payer, ModelID: r.ModelID, Engine: r.Engine, EstimatedUnits: 100},
		{RunID: r.RunID, OwnerSID: owner, PayerSID: payer, ModelID: r.ModelID, Engine: "kimi", EstimatedUnits: 100},
	} {
		if err := s.ReserveSharedRun(ctx, changed); !errors.Is(err, ErrIdempotencyConflict) {
			t.Fatalf("changed identity accepted: %v", err)
		}
	}
	request := ReserveRequest{RunID: r.RunID, ModelID: r.ModelID, Engine: r.Engine, EstimatedUnits: r.EstimatedUnits}
	if _, err := s.ReserveRuntime(ctx, payer, payer, request); !errors.Is(err, ErrReservationNotFound) {
		t.Fatalf("other owner accepted: %v", err)
	}
	if err := s.SettleRuntime(ctx, owner, payer, SettleRequest{RunID: r.RunID}); !errors.Is(err, ErrRunNotAccepted) {
		t.Fatalf("settled before accept: %v", err)
	}
	first, err := s.ReserveRuntime(ctx, owner, payer, request)
	if err != nil || !first.Accepted || first.AlreadyAccepted {
		t.Fatalf("first claim=%+v %v", first, err)
	}
	second, err := s.ReserveRuntime(ctx, owner, payer, request)
	if err != nil || !second.AlreadyAccepted {
		t.Fatalf("repeat claim=%+v %v", second, err)
	}
	if err := s.ReleaseSharedRun(ctx, payer, r.RunID); !errors.Is(err, contracts.ErrQuotaRunAccepted) {
		t.Fatalf("accepted cancelled: %v", err)
	}
	if err := s.SettleRuntime(ctx, payer, payer, SettleRequest{RunID: r.RunID, ActualUnits: 100}); !errors.Is(err, ErrReservationNotFound) {
		t.Fatalf("payer could impersonate execution: %v", err)
	}
}

func TestUnacceptedSharedAdmissionClosesWithoutGatewayHold(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	payer := "S-1-5-21-2"
	if err := s.SetBudget(ctx, Budget{SID: payer, ModelID: "model", Period: Daily, LimitUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	r := contracts.SharedRunQuotaRequest{RunID: "unclaimed", OwnerSID: "S-1-5-21-1", PayerSID: payer, ModelID: "model", EstimatedUnits: 100}
	if err := s.ReserveSharedRun(ctx, r); err != nil {
		t.Fatal(err)
	}
	s.UseGatewayAccounting()
	for i := 0; i < 2; i++ {
		if err := s.ReleaseSharedRun(ctx, payer, r.RunID); err != nil {
			t.Fatal(err)
		}
	}
	closed, err := s.ReserveRuntime(ctx, r.OwnerSID, payer, ReserveRequest{RunID: r.RunID, ModelID: r.ModelID, EstimatedUnits: 100})
	if err != nil || closed.Status != "settled" || closed.Accepted {
		t.Fatalf("closed claimed: %+v %v", closed, err)
	}
	var holds int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM quota_gateway_holds`).Scan(&holds); err != nil || holds != 0 {
		t.Fatalf("hold=%d %v", holds, err)
	}
}

func TestLegacyAuthorizationUsesBusinessIdentityNotOldGatewayOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.db")
	s, err := Open(path, authorizationStub{true})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	payer := "S-1-5-21-2"
	owner := "S-1-5-21-1"
	attacker := "S-1-5-21-3"
	if err := s.SetBudget(ctx, Budget{SID: payer, ModelID: "model", Period: Daily, LimitUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reserve(ctx, ReserveRequest{RunID: "legacy", SID: payer, ModelID: "model", EstimatedUnits: 100}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO quota_gateway_run_owners(run_id,sid) VALUES('legacy',?)`, attacker); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path, authorizationStub{false})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.LookupRuntimeRun(ctx, attacker, "legacy"); !errors.Is(err, ErrReservationNotFound) {
		t.Fatalf("old owner elevated: %v", err)
	}
	if _, err := s.ReserveRuntime(ctx, payer, "", ReserveRequest{RunID: "legacy", ModelID: "model", Engine: "codex", EstimatedUnits: 100}); !errors.Is(err, ErrReservationNotFound) {
		t.Fatalf("legacy payer inferred execution ownership: %v", err)
	}
	if err := s.SettleRuntime(ctx, payer, "", SettleRequest{RunID: "legacy", ActualUnits: 0}); !errors.Is(err, ErrReservationNotFound) {
		t.Fatalf("legacy payer bypassed controlled recovery: %v", err)
	}
	r := contracts.SharedRunIdentity{RunID: "legacy", OwnerSID: owner, PayerSID: payer, Engine: "codex", State: "failed"}
	for i := 0; i < 2; i++ {
		if err := s.RecoverSharedRunAuthorization(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.LookupRuntimeRun(ctx, owner, "legacy"); err != nil {
		t.Fatalf("revoked model blocked recovery: %v", err)
	}
	if err := s.SettleRuntime(ctx, owner, "", SettleRequest{RunID: "legacy", ActualUnits: 60}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LookupRuntimeRun(ctx, attacker, "legacy"); !errors.Is(err, ErrReservationNotFound) {
		t.Fatal("attacker acquired restored run")
	}
	if err := s.SettleRuntime(ctx, owner, "", SettleRequest{RunID: "legacy", ActualUnits: 60}); err != nil {
		t.Fatal(err)
	}
}

func TestCompletedSharedSettlementSurvivesLateDrainAndRestart(t *testing.T) {
	s, payer := accountingStore(t)
	ctx := t.Context()
	owner := "S-1-5-21-999"
	r := contracts.SharedRunQuotaRequest{RunID: "shared-trusted", OwnerSID: owner, PayerSID: payer, ModelID: "gpt-test", Engine: "codex", EstimatedUnits: 1000}
	if err := s.ReserveSharedRun(ctx, r); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReserveRuntime(ctx, owner, payer, ReserveRequest{RunID: r.RunID, ModelID: r.ModelID, Engine: r.Engine, EstimatedUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	at := s.now().Add(time.Second)
	s.now = func() time.Time { return at }
	if err := s.SettleRuntime(ctx, owner, "", SettleRequest{RunID: r.RunID, ActualUnits: 1000}); !errors.Is(err, ErrUsagePending) {
		t.Fatalf("late drain expected: %v", err)
	}
	// A new Store represents a restarted Portal over the same durable DB.
	restarted := &Store{db: s.db, authorizer: s.authorizer, now: s.now, gatewayAccounting: true}
	if err := s.RecordGatewayUsage(ctx, gatewayRecord("late-request", owner, "gpt-test", 700, at)); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkGatewayDrained(ctx, at.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := restarted.ReconcileSettlements(ctx); err != nil {
			t.Fatal(err)
		}
	}
	got, found, err := reservationByRun(ctx, s.db, r.RunID)
	if err != nil || !found || got.Status != "settled" || got.ActualUnits == nil || *got.ActualUnits != 700 {
		t.Fatalf("settlement=%+v %v", got, err)
	}
	usage, err := s.GatewayUsage(ctx, payer, at.Add(time.Minute))
	if err != nil || usage.DailyTokens != 700 {
		t.Fatalf("payer ledger=%+v %v", usage, err)
	}
	usage, err = s.GatewayUsage(ctx, owner, at.Add(time.Minute))
	if err != nil || usage.DailyTokens != 0 {
		t.Fatalf("owner double charge=%+v %v", usage, err)
	}
}

func TestSharedSettlementKeepsAdmittedAliasesAfterRevocationAndCountsCancelledUsage(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	payer := "S-1-5-21-22"
	owner := "S-1-5-21-11"
	s.authorizer = catalogStub{aliases: map[string][]string{"logical-model": {"actual-model"}}}
	if err := s.SetBudget(ctx, Budget{SID: payer, ModelID: "logical-model", Period: Daily, LimitUnits: 10000}); err != nil {
		t.Fatal(err)
	}
	r := contracts.SharedRunQuotaRequest{RunID: "revoked-shared", OwnerSID: owner, PayerSID: payer, ModelID: "logical-model", Engine: "codex", EstimatedUnits: 1000}
	if err := s.ReserveSharedRun(ctx, r); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReserveRuntime(ctx, owner, payer, ReserveRequest{RunID: r.RunID, ModelID: r.ModelID, Engine: r.Engine, EstimatedUnits: 1000}); err != nil {
		t.Fatal(err)
	}
	s.UseGatewayAccounting()
	s.authorizer = authorizationStub{false}
	at := s.now().Add(time.Second)
	s.now = func() time.Time { return at }
	if err := s.SettleRuntime(ctx, owner, "", SettleRequest{RunID: r.RunID, ActualUnits: 0}); !errors.Is(err, ErrUsagePending) {
		t.Fatalf("pending=%v", err)
	}
	record := gatewayRecord("cancelled-shared-request", owner, "actual-model", 400, at)
	record.Failed = true
	if err := s.RecordGatewayUsage(ctx, record); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkGatewayDrained(ctx, at.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.ReconcileSettlements(ctx); err != nil {
		t.Fatal(err)
	}
	settled, _, err := reservationByRun(ctx, s.db, r.RunID)
	if err != nil || settled.ActualUnits == nil || *settled.ActualUnits != 400 {
		t.Fatalf("revoked alias/cancellation lost usage: %+v %v", settled, err)
	}
}
