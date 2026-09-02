package quota

import (
	"context"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

// catalogStub resolves internal model IDs to the names clients send to the
// gateway, the same role modelaccess.Store plays in production.
type catalogStub struct {
	aliases map[string][]string
}

func (c catalogStub) Authorized(context.Context, string, string) (bool, error) { return true, nil }

func (c catalogStub) ListAuthorized(_ context.Context, _ string) ([]contracts.AuthorizedModel, error) {
	models := make([]contracts.AuthorizedModel, 0, len(c.aliases))
	for id, aliases := range c.aliases {
		models = append(models, contracts.AuthorizedModel{
			Model: contracts.Model{ID: id, Aliases: aliases},
		})
	}
	return models, nil
}

func openRecorderStore(t *testing.T) *Store {
	t.Helper()
	store, err := OpenRecorder(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	store.now = func() time.Time { return time.Date(2026, 8, 31, 1, 0, 0, 0, time.UTC) }
	return store
}

func gatewayRecord(requestID, sid, model string, total int64, at time.Time) contracts.GatewayUsageRecord {
	return contracts.GatewayUsageRecord{
		RequestID: requestID, SID: sid, Provider: "openai", Model: model, Alias: model,
		Endpoint: "POST /v1/responses", AuthType: "api_key",
		InputTokens: total, TotalTokens: total, OccurredAt: at,
	}
}

func TestGatewayKeyIndexMapsKeyIDs(t *testing.T) {
	ctx := t.Context()
	store := openRecorderStore(t)
	const sid = "S-1-5-21-4000"
	const keyID = "aionui-0123456789abcdef0123-chatgpt"
	if err := store.IndexGatewayKeys(ctx, sid, []string{keyID}); err != nil {
		t.Fatal(err)
	}
	mapped, found, err := store.MapGatewayKey(ctx, keyID)
	if err != nil || !found || mapped != sid {
		t.Fatalf("map = %q, %v, %v", mapped, found, err)
	}
	if _, found, err := store.MapGatewayKey(ctx, "aionui-ffffffffffffffffffff-kimi"); err != nil || found {
		t.Fatalf("unknown key ID mapped: found=%v err=%v", found, err)
	}
	// Re-indexing is idempotent (key rotation replays; IDs survive rotation).
	if err := store.IndexGatewayKeys(ctx, sid, []string{keyID}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM quota_gateway_keys WHERE key_id = ?`, keyID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("index rows for key ID = %d", count)
	}
	if err := store.IndexGatewayKeys(ctx, "not-a-sid", []string{keyID}); err == nil {
		t.Fatal("invalid SID was accepted")
	}
	for _, invalid := range []string{"  ", "cpa_plaintext-key-material", "aionui-0123"} {
		if err := store.IndexGatewayKeys(ctx, sid, []string{invalid}); err == nil {
			t.Fatalf("invalid key ID was accepted: %q", invalid)
		}
	}
}

func TestRecordGatewayUsageDeduplicatesByRequestID(t *testing.T) {
	ctx := t.Context()
	store := openRecorderStore(t)
	const sid = "S-1-5-21-4001"
	at := store.now()
	record := gatewayRecord("req-1", sid, "gpt-5.6-sol", 30, at)
	if err := store.RecordGatewayUsage(ctx, record); err != nil {
		t.Fatal(err)
	}
	// At-least-once redelivery of the same request ID is skipped.
	duplicate := record
	duplicate.TotalTokens, duplicate.InputTokens = 9999, 9999
	if err := store.RecordGatewayUsage(ctx, duplicate); err != nil {
		t.Fatal(err)
	}
	usage, err := store.GatewayUsage(ctx, sid, at)
	if err != nil {
		t.Fatal(err)
	}
	if usage.DailyTokens != 30 || usage.WeeklyTokens != 30 || len(usage.Models) != 1 || usage.Models[0].Requests != 1 {
		t.Fatalf("usage = %#v", usage)
	}
	for _, invalid := range []contracts.GatewayUsageRecord{
		{SID: sid, TotalTokens: 1, OccurredAt: at},
		{RequestID: "req-x", SID: "not-a-sid", TotalTokens: 1, OccurredAt: at},
		{RequestID: "req-y", SID: sid, TotalTokens: -1, OccurredAt: at},
		{RequestID: "req-z", SID: sid, TotalTokens: 1},
	} {
		if err := store.RecordGatewayUsage(ctx, invalid); err == nil {
			t.Fatalf("invalid record was accepted: %#v", invalid)
		}
	}
}

func TestGatewayUsageSumsDailyAndWeeklyWindows(t *testing.T) {
	ctx := t.Context()
	store := openRecorderStore(t)
	const sid = "S-1-5-21-4002"
	at := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC) // Wednesday
	yesterday := at.Add(-26 * time.Hour)               // same ISO week, previous UTC day
	lastWeek := at.Add(-8 * 24 * time.Hour)
	for _, record := range []contracts.GatewayUsageRecord{
		gatewayRecord("today", sid, "gpt-5.6-sol", 10, at),
		gatewayRecord("yesterday", sid, "gpt-5.6-sol", 20, yesterday),
		gatewayRecord("last-week", sid, "kimi-k3", 40, lastWeek),
	} {
		if err := store.RecordGatewayUsage(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	failed := gatewayRecord("failed", sid, "gpt-5.6-sol", 100, at)
	failed.Failed = true
	if err := store.RecordGatewayUsage(ctx, failed); err != nil {
		t.Fatal(err)
	}
	usage, err := store.GatewayUsage(ctx, sid, at)
	if err != nil {
		t.Fatal(err)
	}
	if usage.DailyPeriodKey != "2026-09-02" || usage.DailyTokens != 10 {
		t.Fatalf("daily = %s/%d", usage.DailyPeriodKey, usage.DailyTokens)
	}
	if usage.WeeklyTokens != 30 {
		t.Fatalf("weekly = %d, want 30 (last week and failed excluded)", usage.WeeklyTokens)
	}
	if len(usage.Models) != 1 || usage.Models[0].Model != "gpt-5.6-sol" || usage.Models[0].TotalTokens != 10 {
		t.Fatalf("models = %#v", usage.Models)
	}
}

func TestSettlePrefersGatewayTokensAndPinsMatchedRecords(t *testing.T) {
	ctx := t.Context()
	store, err := Open(":memory:", catalogStub{aliases: map[string][]string{
		"harness-default": {"default", "gpt-5.6-sol"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 31, 1, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	const sid = "S-1-5-21-4003"
	if err := store.SetBudget(ctx, Budget{SID: sid, ModelID: "harness-default", Period: Daily, LimitUnits: 100000}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reserve(ctx, ReserveRequest{RunID: "run-1", SID: sid, ModelID: "harness-default", EstimatedUnits: 1024}); err != nil {
		t.Fatal(err)
	}
	// Two successful requests plus one failed and one outside the window.
	for _, record := range []contracts.GatewayUsageRecord{
		gatewayRecord("r-1", sid, "gpt-5.6-sol", 500, now.Add(time.Minute)),
		gatewayRecord("r-2", sid, "default", 300, now.Add(2*time.Minute)),
	} {
		if err := store.RecordGatewayUsage(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	failed := gatewayRecord("r-failed", sid, "gpt-5.6-sol", 900, now.Add(time.Minute))
	failed.Failed = true
	stale := gatewayRecord("r-stale", sid, "gpt-5.6-sol", 900, now.Add(-time.Hour))
	foreign := gatewayRecord("r-foreign", "S-1-5-21-4999", "gpt-5.6-sol", 900, now.Add(time.Minute))
	for _, record := range []contracts.GatewayUsageRecord{failed, stale, foreign} {
		if err := store.RecordGatewayUsage(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Settle(ctx, SettleRequest{RunID: "run-1", ActualUnits: 1024}); err != nil {
		t.Fatal(err)
	}
	usage, err := store.Usage(ctx, sid, "harness-default", now)
	if err != nil || usage.ConsumedUnits != 800 {
		t.Fatalf("consumed = %#v, want 800 gateway tokens (err=%v)", usage, err)
	}
	var source string
	var pinned int
	if err := store.db.QueryRow(`SELECT settle_source FROM quota_reservations WHERE run_id = 'run-1'`).Scan(&source); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM quota_gateway_usage WHERE matched_run_id = 'run-1'`).Scan(&pinned); err != nil {
		t.Fatal(err)
	}
	if source != "gateway" || pinned != 2 {
		t.Fatalf("settle source = %q, pinned records = %d", source, pinned)
	}

	// The next run finds no unmatched records: the failed, stale, foreign, and
	// already-pinned rows are invisible, so it settles on the conservative
	// estimate and is marked estimated.
	if _, err := store.Reserve(ctx, ReserveRequest{RunID: "run-2", SID: sid, ModelID: "harness-default", EstimatedUnits: 1024}); err != nil {
		t.Fatal(err)
	}
	if err := store.Settle(ctx, SettleRequest{RunID: "run-2", ActualUnits: 1024}); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT settle_source FROM quota_reservations WHERE run_id = 'run-2'`).Scan(&source); err != nil {
		t.Fatal(err)
	}
	if source != "estimated" {
		t.Fatalf("settle source = %q, want estimated", source)
	}
	usage, err = store.Usage(ctx, sid, "harness-default", now)
	if err != nil || usage.ConsumedUnits != 800+1024 {
		t.Fatalf("consumed = %#v", usage)
	}
	// Replaying run-1's settlement with its final actual stays idempotent.
	if err := store.Settle(ctx, SettleRequest{RunID: "run-1", ActualUnits: 800}); err != nil {
		t.Fatal(err)
	}
}

func TestSettleWithoutCatalogMatchesExactModelIDOnly(t *testing.T) {
	ctx := t.Context()
	store := openTestStore(t) // authorizationStub exposes no catalog aliases
	const sid = "S-1-5-21-4004"
	if err := store.SetBudget(ctx, Budget{SID: sid, ModelID: "codex-native", Period: Daily, LimitUnits: 100000}); err != nil {
		t.Fatal(err)
	}
	now := store.now()
	if _, err := store.Reserve(ctx, ReserveRequest{RunID: "run-1", SID: sid, ModelID: "codex-native", EstimatedUnits: 100}); err != nil {
		t.Fatal(err)
	}
	// A gateway record for the real upstream model name does not match the
	// internal ID without a catalog alias.
	if err := store.RecordGatewayUsage(ctx, gatewayRecord("r-1", sid, "gpt-5.6-sol", 500, now)); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordGatewayUsage(ctx, gatewayRecord("r-2", sid, "codex-native", 42, now)); err != nil {
		t.Fatal(err)
	}
	if err := store.Settle(ctx, SettleRequest{RunID: "run-1", ActualUnits: 100}); err != nil {
		t.Fatal(err)
	}
	usage, err := store.Usage(ctx, sid, "codex-native", now)
	if err != nil || usage.ConsumedUnits != 42 {
		t.Fatalf("consumed = %#v, want 42", usage)
	}
}

func TestSpeechSettlementKeepsReportedSeconds(t *testing.T) {
	ctx := t.Context()
	store := openTestStore(t)
	const sid = "S-1-5-21-4005"
	if err := store.SetBudget(ctx, Budget{SID: sid, ModelID: SpeechTranscriptionModelID, Period: Daily, LimitUnits: 300}); err != nil {
		t.Fatal(err)
	}
	if err := store.ReserveSpeech(ctx, sid, "speech-1", 60); err != nil {
		t.Fatal(err)
	}
	if err := store.SettleSpeech(ctx, "speech-1", 7); err != nil {
		t.Fatal(err)
	}
	var source *string
	if err := store.db.QueryRow(`SELECT settle_source FROM quota_reservations WHERE run_id = 'speech-1'`).Scan(&source); err != nil {
		t.Fatal(err)
	}
	if source != nil {
		t.Fatalf("speech settlement gained a gateway source: %q", *source)
	}
}

func TestRecorderStoreCannotReserve(t *testing.T) {
	store := openRecorderStore(t)
	_, err := store.Reserve(t.Context(), ReserveRequest{RunID: "run-1", SID: "S-1-5-21-4006", ModelID: "m", EstimatedUnits: 1})
	if err == nil || !strings.Contains(err.Error(), "authorization port") {
		t.Fatalf("recorder store reserved quota: %v", err)
	}
}
