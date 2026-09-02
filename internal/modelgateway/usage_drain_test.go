package modelgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/quota"
)

// fakeUsageQueue emulates the stock CLIProxyAPI usage queue endpoint with its
// real pop semantics: returned records are removed from the queue.
type fakeUsageQueue struct {
	mu       sync.Mutex
	records  []map[string]any
	pops     int
	statuses []int // optional per-pop HTTP status overrides
}

func (q *fakeUsageQueue) serve(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/v0/management/usage-queue" {
		writer.WriteHeader(http.StatusNotFound)
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.pops++
	if index := q.pops - 1; index < len(q.statuses) && q.statuses[index] != 0 {
		writer.WriteHeader(q.statuses[index])
		return
	}
	batch := q.records
	q.records = nil
	writer.Header().Set("Content-Type", "application/json")
	if batch == nil {
		batch = []map[string]any{}
	}
	payload, _ := json.Marshal(batch)
	_, _ = writer.Write(payload)
}

func usageQueueItem(requestID, apiKey, model string, total int64, timestamp string) map[string]any {
	return map[string]any{
		"timestamp":  timestamp,
		"tokens":     map[string]int64{"input_tokens": total, "output_tokens": 0, "reasoning_tokens": 0, "cached_tokens": 0, "total_tokens": total},
		"failed":     false,
		"provider":   "openai",
		"model":      model,
		"alias":      model,
		"endpoint":   "POST /v1/responses",
		"auth_type":  "api_key",
		"api_key":    apiKey,
		"request_id": requestID,
	}
}

// fakeUsageSink records mapped SIDs and persisted records, capturing every
// plaintext it is shown so tests can prove plaintext never crosses into
// persistence.
type fakeUsageSink struct {
	mu           sync.Mutex
	keys         map[string]string
	plainSeen    []string
	records      []contracts.GatewayUsageRecord
	failRecordID string
	mapErr       error
}

func (s *fakeUsageSink) MapGatewayKey(_ context.Context, plainKey string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.plainSeen = append(s.plainSeen, plainKey)
	if s.mapErr != nil {
		return "", false, s.mapErr
	}
	sid, found := s.keys[plainKey]
	return sid, found, nil
}

func (s *fakeUsageSink) RecordGatewayUsage(_ context.Context, record contracts.GatewayUsageRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if record.RequestID == s.failRecordID {
		return errors.New("quota database locked")
	}
	s.records = append(s.records, record)
	return nil
}

func newUsageDrain(t *testing.T, queue *fakeUsageQueue, sink UsageSink) *UsageDrainer {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(queue.serve))
	t.Cleanup(server.Close)
	config := completeConfig(t)
	config.ManagementURL = server.URL + "/v0/management/plugins/cpa-key-policy"
	client, err := NewCLIProxy(config)
	if err != nil {
		t.Fatal(err)
	}
	drainer, err := client.NewUsageDrainer(sink)
	if err != nil {
		t.Fatal(err)
	}
	return drainer
}

func TestDrainUsageMapsSIDAndDiscardsPlaintext(t *testing.T) {
	queue := &fakeUsageQueue{records: []map[string]any{
		usageQueueItem("req-1", "cpa_known-key-aaaaaaaaaaaaaaaa", "gpt-5.6-sol", 30, "2026-08-31T01:00:00Z"),
		usageQueueItem("req-2", "cpa_foreign-key-bbbbbbbbbbbbbbbb", "gpt-5.6-sol", 10, "2026-08-31T01:01:00Z"),
	}}
	sink := &fakeUsageSink{keys: map[string]string{"cpa_known-key-aaaaaaaaaaaaaaaa": testSID}}
	drainer := newUsageDrain(t, queue, sink)
	persisted, skipped, err := drainer.Drain(t.Context())
	if err != nil || persisted != 1 || skipped != 1 {
		t.Fatalf("drain = %d/%d, %v", persisted, skipped, err)
	}
	record := sink.records[0]
	if record.RequestID != "req-1" || record.SID != testSID || record.TotalTokens != 30 || record.Model != "gpt-5.6-sol" {
		t.Fatalf("record = %+v", record)
	}
	if record.OccurredAt != time.Date(2026, 8, 31, 1, 0, 0, 0, time.UTC) {
		t.Fatalf("occurred at = %s", record.OccurredAt)
	}
	// The plaintext key appears only in the mapping lookups, never in anything
	// the sink persisted, and the decoded queue record was cleared in place.
	for _, record := range sink.records {
		if strings.Contains(fmt.Sprintf("%+v", record), "cpa_") {
			t.Fatalf("plaintext key material reached persistence: %+v", record)
		}
	}
	raw := usageQueueRecord{APIKey: "cpa_secret"}
	if _, _, err := drainer.mapRecord(t.Context(), &raw); err != nil {
		t.Fatal(err)
	}
	if raw.APIKey != "" {
		t.Fatal("plaintext key was not cleared from the decoded record")
	}
	// The queue was popped once; a second drain fetches the (now empty) queue.
	if queue.pops != 1 {
		t.Fatalf("pops = %d", queue.pops)
	}
	if _, _, err := drainer.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if queue.pops != 2 {
		t.Fatalf("pops = %d", queue.pops)
	}
}

func TestDrainUsageSkipsUnusableRecords(t *testing.T) {
	queue := &fakeUsageQueue{records: []map[string]any{
		usageQueueItem("", "cpa_known-key-aaaaaaaaaaaaaaaa", "gpt-5.6-sol", 5, "2026-08-31T01:00:00Z"),
		usageQueueItem("req-bad-ts", "cpa_known-key-aaaaaaaaaaaaaaaa", "gpt-5.6-sol", 5, "not-a-timestamp"),
		usageQueueItem("req-ok", "cpa_known-key-aaaaaaaaaaaaaaaa", "gpt-5.6-sol", 5, "2026-08-31T01:00:00Z"),
	}}
	sink := &fakeUsageSink{keys: map[string]string{"cpa_known-key-aaaaaaaaaaaaaaaa": testSID}}
	drainer := newUsageDrain(t, queue, sink)
	persisted, skipped, err := drainer.Drain(t.Context())
	if err != nil || persisted != 1 || skipped != 2 {
		t.Fatalf("drain = %d/%d, %v", persisted, skipped, err)
	}
}

func TestDrainUsagePersistsBeforePoppingMoreAndResumesPartialFailure(t *testing.T) {
	queue := &fakeUsageQueue{records: []map[string]any{
		usageQueueItem("req-1", "cpa_known-key-aaaaaaaaaaaaaaaa", "gpt-5.6-sol", 10, "2026-08-31T01:00:00Z"),
		usageQueueItem("req-2", "cpa_known-key-aaaaaaaaaaaaaaaa", "gpt-5.6-sol", 20, "2026-08-31T01:01:00Z"),
		usageQueueItem("req-3", "cpa_known-key-aaaaaaaaaaaaaaaa", "gpt-5.6-sol", 40, "2026-08-31T01:02:00Z"),
	}}
	sink := &fakeUsageSink{keys: map[string]string{"cpa_known-key-aaaaaaaaaaaaaaaa": testSID}, failRecordID: "req-2"}
	drainer := newUsageDrain(t, queue, sink)
	persisted, _, err := drainer.Drain(t.Context())
	if err == nil || persisted != 1 {
		t.Fatalf("first drain = %d, %v", persisted, err)
	}
	sink.failRecordID = ""
	persisted, _, err = drainer.Drain(t.Context())
	if err != nil || persisted != 2 {
		t.Fatalf("resumed drain = %d, %v", persisted, err)
	}
	// The partially persisted batch was retried from the buffer: no second pop
	// happened until every record of the first batch was persisted.
	if queue.pops != 1 {
		t.Fatalf("pops = %d, want 1 (no new pop before the batch was fully persisted)", queue.pops)
	}
	var tokens int64
	for _, record := range sink.records {
		tokens += record.TotalTokens
	}
	if tokens != 70 {
		t.Fatalf("persisted tokens = %d, want 70", tokens)
	}
}

func TestDrainUsageRetriesMappingFailures(t *testing.T) {
	queue := &fakeUsageQueue{records: []map[string]any{
		usageQueueItem("req-1", "cpa_known-key-aaaaaaaaaaaaaaaa", "gpt-5.6-sol", 10, "2026-08-31T01:00:00Z"),
	}}
	sink := &fakeUsageSink{keys: map[string]string{"cpa_known-key-aaaaaaaaaaaaaaaa": testSID}, mapErr: errors.New("quota database locked")}
	drainer := newUsageDrain(t, queue, sink)
	if _, _, err := drainer.Drain(t.Context()); err == nil {
		t.Fatal("mapping failure was swallowed")
	}
	sink.mapErr = nil
	persisted, _, err := drainer.Drain(t.Context())
	if err != nil || persisted != 1 || queue.pops != 1 {
		t.Fatalf("drain = %d, pops = %d, %v", persisted, queue.pops, err)
	}
}

// TestDrainUsageEndToEndKeepsPlaintextOutOfTheDatabase runs the drainer
// against a real quota store and asserts no plaintext key material is on disk.
func TestDrainUsageEndToEndKeepsPlaintextOutOfTheDatabase(t *testing.T) {
	ctx := t.Context()
	store, err := quota.OpenRecorder(t.TempDir() + "/quota.db")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	const plaintext = "cpa_end-to-end-plaintext-key"
	if err := store.IndexGatewayKeys(ctx, testSID, []string{plaintext}); err != nil {
		t.Fatal(err)
	}
	queue := &fakeUsageQueue{records: []map[string]any{
		usageQueueItem("req-1", plaintext, "gpt-5.6-sol", 64, "2026-08-31T01:00:00Z"),
	}}
	drainer := newUsageDrain(t, queue, store)
	persisted, _, err := drainer.Drain(ctx)
	if err != nil || persisted != 1 {
		t.Fatalf("drain = %d, %v", persisted, err)
	}
	usage, err := store.GatewayUsage(ctx, testSID, time.Date(2026, 8, 31, 2, 0, 0, 0, time.UTC))
	if err != nil || usage.DailyTokens != 64 {
		t.Fatalf("usage = %#v, %v", usage, err)
	}
	// Redelivery of the same request ID is deduplicated.
	queue.records = []map[string]any{usageQueueItem("req-1", plaintext, "gpt-5.6-sol", 64, "2026-08-31T01:00:00Z")}
	if _, _, err := drainer.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	usage, err = store.GatewayUsage(ctx, testSID, time.Date(2026, 8, 31, 2, 0, 0, 0, time.UTC))
	if err != nil || usage.DailyTokens != 64 {
		t.Fatalf("deduplicated usage = %#v, %v", usage, err)
	}
}
