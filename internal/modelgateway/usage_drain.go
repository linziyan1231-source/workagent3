package modelgateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"workagent3/internal/contracts"
)

// UsageDrainBatch is the number of queue records popped per drain cycle.
const UsageDrainBatch = 200

// UsageSink persists drained gateway usage. quota.Store implements it.
// Gateway records identify the caller by the managed key ID (never by key
// material), which MapGatewayKey resolves to the owning SID.
type UsageSink interface {
	MapGatewayKey(ctx context.Context, keyID string) (sid string, found bool, err error)
	RecordGatewayUsage(ctx context.Context, record contracts.GatewayUsageRecord) error
}

// usageQueueRecord mirrors one CLIProxyAPI /v0/management/usage-queue item.
type usageQueueRecord struct {
	Timestamp string `json:"timestamp"`
	Tokens    struct {
		InputTokens     int64 `json:"input_tokens"`
		OutputTokens    int64 `json:"output_tokens"`
		ReasoningTokens int64 `json:"reasoning_tokens"`
		CachedTokens    int64 `json:"cached_tokens"`
		TotalTokens     int64 `json:"total_tokens"`
	} `json:"tokens"`
	Failed    bool   `json:"failed"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Alias     string `json:"alias"`
	Endpoint  string `json:"endpoint"`
	AuthType  string `json:"auth_type"`
	APIKey    string `json:"api_key"`
	RequestID string `json:"request_id"`
}

// UsageDrainer consumes the gateway usage queue. The endpoint pops records on
// read, so a popped batch is retained in memory and every record is persisted
// before the next batch is popped: a mapping or persistence failure leaves the
// remaining records buffered and the next Drain retries them instead of
// fetching more. Records attribute callers by managed key ID, never by key
// material. There must be exactly one drainer per deployment (the Employee
// Manager).
type UsageDrainer struct {
	client    *Client
	sink      UsageSink
	raw       []usageQueueRecord
	pending   []contracts.GatewayUsageRecord
	skipped   int
	started   time.Time
	batchSize int
}

func (c *Client) NewUsageDrainer(sink UsageSink) (*UsageDrainer, error) {
	if sink == nil {
		return nil, errors.New("usage sink is required")
	}
	return &UsageDrainer{client: c, sink: sink}, nil
}

// Drain maps and persists any buffered batch, then pops and persists the next
// one. It returns the number of records persisted and the number skipped
// because their key ID belongs to no managed employee key or the record is
// unusable (missing request ID or timestamp).
func (d *UsageDrainer) Drain(ctx context.Context) (persisted, skipped int, err error) {
	if len(d.pending) == 0 && len(d.raw) == 0 {
		d.started = time.Now()
		raw, err := d.client.popUsage(ctx, UsageDrainBatch)
		if err != nil {
			return 0, 0, err
		}
		d.raw = raw
		d.batchSize = len(raw)
		d.skipped = 0
	}
	for len(d.raw) > 0 {
		record, usable, err := d.mapRecord(ctx, &d.raw[0])
		if err != nil {
			return persisted, d.skipped, err
		}
		d.raw = d.raw[1:]
		if !usable {
			d.skipped++
			continue
		}
		d.pending = append(d.pending, record)
	}
	for len(d.pending) > 0 {
		if err := d.sink.RecordGatewayUsage(ctx, d.pending[0]); err != nil {
			return persisted, d.skipped, fmt.Errorf("persist gateway usage %q: %w", d.pending[0].RequestID, err)
		}
		d.pending = d.pending[1:]
		persisted++
	}
	if checkpoint, ok := d.sink.(interface {
		MarkGatewayDrained(context.Context, time.Time) error
	}); ok && d.batchSize < UsageDrainBatch {
		if err := checkpoint.MarkGatewayDrained(ctx, d.started); err != nil {
			return persisted, d.skipped, err
		}
	}
	return persisted, d.skipped, nil
}

// mapRecord attributes one queue record to its owning SID through the managed
// key ID the record carries. Records without a usable request ID or timestamp,
// or whose key ID belongs to no managed employee, are reported unusable and
// dropped.
func (d *UsageDrainer) mapRecord(ctx context.Context, raw *usageQueueRecord) (contracts.GatewayUsageRecord, bool, error) {
	sid, found, err := d.sink.MapGatewayKey(ctx, raw.APIKey)
	if err != nil {
		// The record stays buffered so the next Drain can retry the mapping
		// once the store recovers.
		return contracts.GatewayUsageRecord{}, false, fmt.Errorf("map gateway usage key: %w", err)
	}
	occurredAt, parseErr := time.Parse(time.RFC3339, raw.Timestamp)
	if !found || raw.RequestID == "" || parseErr != nil {
		return contracts.GatewayUsageRecord{}, false, nil
	}
	return contracts.GatewayUsageRecord{
		RequestID: raw.RequestID, SID: sid, Provider: raw.Provider, Model: raw.Model,
		Alias: raw.Alias, Endpoint: raw.Endpoint, AuthType: raw.AuthType, Failed: raw.Failed,
		InputTokens: raw.Tokens.InputTokens, OutputTokens: raw.Tokens.OutputTokens,
		ReasoningTokens: raw.Tokens.ReasoningTokens, CachedTokens: raw.Tokens.CachedTokens,
		TotalTokens: raw.Tokens.TotalTokens, OccurredAt: occurredAt,
	}, true, nil
}

// popUsage pops up to count records from the stock usage queue endpoint,
// served by CLIProxyAPI core on the same origin as the key-policy plugin.
func (c *Client) popUsage(ctx context.Context, count int) ([]usageQueueRecord, error) {
	endpoint, err := url.Parse(c.config.ManagementURL)
	if err != nil {
		return nil, errors.New("CLIProxyAPI management URL is invalid")
	}
	endpoint.Path = "/v0/management/usage-queue"
	endpoint.RawPath = ""
	endpoint.RawQuery = "count=" + strconv.Itoa(count)
	var records []usageQueueRecord
	if err := c.jsonURL(ctx, http.MethodGet, endpoint.String(), nil, &records); err != nil {
		return nil, err
	}
	return records, nil
}
