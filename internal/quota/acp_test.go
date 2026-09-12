package quota

import (
	"errors"
	"testing"
)

func TestACPUsesFixedTokenBudgetAndEstimatedSettlementWithoutGatewayDrain(t *testing.T) {
	s, sid := accountingStore(t)
	ctx := t.Context()
	if err := s.SetBudget(ctx, Budget{SID: sid, ModelID: "gpt-test", Period: Daily, LimitUnits: 100}); err != nil {
		t.Fatal(err)
	}
	// A configured Codex dollar pool must not turn an external ACP call into
	// gateway-accounted zero usage or override its explicit token budget.
	if _, err := s.db.Exec(`DELETE FROM quota_gateway_checkpoint`); err != nil {
		t.Fatal(err)
	}
	r := ReserveRequest{RunID: "acp-1", SID: sid, ModelID: "gpt-test", Engine: "acp", EstimatedUnits: 60}
	if value, err := s.Reserve(ctx, r); err != nil || value.Engine != "acp" {
		t.Fatalf("admission %+v %v", value, err)
	}
	if err := s.Settle(ctx, SettleRequest{RunID: r.RunID, ActualUnits: 60}); err != nil {
		t.Fatal(err)
	}
	var source string
	var holds int
	if err := s.db.QueryRow(`SELECT settle_source FROM quota_reservations WHERE run_id='acp-1'`).Scan(&source); err != nil || source != "estimated" {
		t.Fatalf("settlement source %s %v", source, err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM quota_gateway_holds`).Scan(&holds); err != nil || holds != 0 {
		t.Fatal("ACP waited for unrelated gateway drain")
	}
	usage, err := s.Usage(ctx, sid, "gpt-test", s.now())
	if err != nil || usage.ConsumedUnits != 60 || usage.ReservedUnits != 0 {
		t.Fatalf("lost external usage %+v %v", usage, err)
	}
	r.RunID = "acp-2"
	r.EstimatedUnits = 41
	if _, err := s.Reserve(ctx, r); !errors.Is(err, ErrExceeded) {
		t.Fatalf("fixed budget bypassed: %v", err)
	}
	r.RunID = "acp-1"
	r.EstimatedUnits = 60
	r.Engine = "codex"
	if _, err := s.Reserve(ctx, r); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatal("replayed ACP as gateway-accounted engine")
	}
}
