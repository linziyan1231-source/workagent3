package quota

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"workagent3/internal/contracts"
)

// gatewayKeyIDPattern matches the managed downstream key IDs the gateway
// usage records carry ("aionui-<hex>-chatgpt" / "aionui-<hex>-kimi").
var gatewayKeyIDPattern = regexp.MustCompile(`^aionui-[0-9a-f]{20}-(chatgpt|kimi)$`)

// gatewayMatchSkew widens the settlement match window to absorb clock skew and
// the gap between a reservation's creation and the first upstream request.
const gatewayMatchSkew = 2 * time.Minute

// modelCatalogPort is optionally implemented by the authorization port to
// resolve an internal model ID to the names clients actually send to the
// gateway (the model ID itself plus its catalog aliases).
type modelCatalogPort interface {
	ListAuthorized(ctx context.Context, sid string) ([]contracts.AuthorizedModel, error)
}

// IndexGatewayKeys records the opaque key ID → SID mapping for freshly
// provisioned downstream keys. Gateway usage records identify the caller by
// the managed key ID (for example "aionui-…-chatgpt"), never by key material,
// so the drain can attribute them without any plaintext key leaving the
// gateway.
func (s *Store) IndexGatewayKeys(ctx context.Context, sid string, keyIDs []string) error {
	if err := validateSID(sid); err != nil {
		return err
	}
	for _, id := range keyIDs {
		if !gatewayKeyIDPattern.MatchString(id) {
			return errors.New("gateway key ID is invalid")
		}
		_, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO quota_gateway_keys(key_id, sid, created_at) VALUES(?, ?, ?)`,
			id, sid, s.now().Unix())
		if err != nil {
			return fmt.Errorf("index gateway key: %w", err)
		}
	}
	return nil
}

// MapGatewayKey resolves the key ID a gateway usage record carries to the
// owning SID.
func (s *Store) MapGatewayKey(ctx context.Context, keyID string) (string, bool, error) {
	var sid string
	err := s.db.QueryRowContext(ctx, `
SELECT sid FROM quota_gateway_keys WHERE key_id = ?`, keyID).Scan(&sid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("map gateway key: %w", err)
	}
	return sid, true, nil
}

// RecordGatewayUsage persists one drained gateway usage record. The request ID
// is the idempotency key: a record that is already stored (for example after
// an at-least-once redelivery upstream) is silently skipped.
func (s *Store) RecordGatewayUsage(ctx context.Context, record contracts.GatewayUsageRecord) error {
	if strings.TrimSpace(record.RequestID) == "" {
		return errors.New("gateway usage request ID is required")
	}
	if err := validateSID(record.SID); err != nil {
		return err
	}
	for _, tokens := range []int64{record.InputTokens, record.OutputTokens, record.ReasoningTokens, record.CachedTokens, record.TotalTokens} {
		if tokens < 0 {
			return errors.New("gateway usage tokens cannot be negative")
		}
	}
	if record.OccurredAt.IsZero() {
		return errors.New("gateway usage timestamp is required")
	}
	failed := 0
	if record.Failed {
		failed = 1
	}
	_, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO quota_gateway_usage(request_id, sid, provider, model, alias, endpoint, auth_type,
  failed, input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens, occurred_at, drained_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.RequestID, record.SID, record.Provider, record.Model, record.Alias, record.Endpoint,
		record.AuthType, failed, record.InputTokens, record.OutputTokens, record.ReasoningTokens,
		record.CachedTokens, record.TotalTokens, record.OccurredAt.Unix(), s.now().Unix())
	if err != nil {
		return fmt.Errorf("record gateway usage: %w", err)
	}
	return nil
}

// GatewayUsage sums the drained authoritative gateway records for one employee
// over the current daily and weekly windows. Failed requests consumed no
// upstream quota and are excluded.
func (s *Store) GatewayUsage(ctx context.Context, sid string, at time.Time) (contracts.GatewayUsage, error) {
	if err := validateSID(sid); err != nil {
		return contracts.GatewayUsage{}, err
	}
	if at.IsZero() {
		at = s.now()
	}
	usage := contracts.GatewayUsage{
		DailyPeriodKey:  periodKey(Daily, at),
		WeeklyPeriodKey: periodKey(Weekly, at),
		Models:          []contracts.GatewayModelUsage{},
	}
	dayStart, _ := time.Parse("2006-01-02", usage.DailyPeriodKey)
	weekStart := isoWeekStart(at)
	if err := s.db.QueryRowContext(ctx, `
SELECT COALESCE(SUM(total_tokens), 0) FROM quota_gateway_usage
WHERE sid = ? AND failed = 0 AND occurred_at >= ?`, sid, dayStart.Unix()).Scan(&usage.DailyTokens); err != nil {
		return contracts.GatewayUsage{}, fmt.Errorf("sum daily gateway usage: %w", err)
	}
	if err := s.db.QueryRowContext(ctx, `
SELECT COALESCE(SUM(total_tokens), 0) FROM quota_gateway_usage
WHERE sid = ? AND failed = 0 AND occurred_at >= ?`, sid, weekStart.Unix()).Scan(&usage.WeeklyTokens); err != nil {
		return contracts.GatewayUsage{}, fmt.Errorf("sum weekly gateway usage: %w", err)
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT model, COALESCE(SUM(total_tokens), 0), COUNT(*) FROM quota_gateway_usage
WHERE sid = ? AND failed = 0 AND occurred_at >= ?
GROUP BY model ORDER BY model`, sid, dayStart.Unix())
	if err != nil {
		return contracts.GatewayUsage{}, fmt.Errorf("group daily gateway usage: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var model contracts.GatewayModelUsage
		if err := rows.Scan(&model.Model, &model.TotalTokens, &model.Requests); err != nil {
			return contracts.GatewayUsage{}, fmt.Errorf("scan gateway model usage: %w", err)
		}
		usage.Models = append(usage.Models, model)
	}
	if err := rows.Err(); err != nil {
		return contracts.GatewayUsage{}, fmt.Errorf("iterate gateway model usage: %w", err)
	}
	return usage, nil
}

// matchGatewayUsage attributes drained gateway records to a settling
// reservation: unmatched, successful records for the same SID whose model or
// alias names the reserved model, inside the window between reservation
// creation and settlement. Matched records are pinned to the run so no later
// settlement can count them again.
func (s *Store) matchGatewayUsage(ctx context.Context, tx *sql.Tx, reservation Reservation) (int64, bool, error) {
	var createdAt int64
	if err := tx.QueryRowContext(ctx, `
SELECT created_at FROM quota_reservations WHERE run_id = ?`, reservation.RunID).Scan(&createdAt); err != nil {
		return 0, false, fmt.Errorf("read reservation creation time: %w", err)
	}
	candidates := s.modelCandidates(ctx, reservation.SID, reservation.ModelID)
	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(candidates)), ", ")
	arguments := []any{reservation.SID, time.Unix(createdAt, 0).Add(-gatewayMatchSkew).Unix(), s.now().Add(gatewayMatchSkew).Unix()}
	// The candidate list appears twice: once for model, once for alias.
	for i := 0; i < 2; i++ {
		for _, candidate := range candidates {
			arguments = append(arguments, candidate)
		}
	}
	rows, err := tx.QueryContext(ctx, fmt.Sprintf(`
SELECT request_id, total_tokens FROM quota_gateway_usage
WHERE sid = ? AND failed = 0 AND matched_run_id IS NULL
  AND occurred_at >= ? AND occurred_at <= ?
  AND (model IN (%s) OR alias IN (%s))
ORDER BY occurred_at`, placeholders, placeholders), arguments...)
	if err != nil {
		return 0, false, fmt.Errorf("match gateway usage: %w", err)
	}
	var requestIDs []string
	var tokens int64
	for rows.Next() {
		var requestID string
		var total int64
		if err := rows.Scan(&requestID, &total); err != nil {
			rows.Close()
			return 0, false, fmt.Errorf("scan matched gateway usage: %w", err)
		}
		requestIDs = append(requestIDs, requestID)
		tokens += total
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, false, fmt.Errorf("iterate matched gateway usage: %w", err)
	}
	rows.Close()
	if len(requestIDs) == 0 {
		return 0, false, nil
	}
	for _, requestID := range requestIDs {
		if _, err := tx.ExecContext(ctx, `
UPDATE quota_gateway_usage SET matched_run_id = ? WHERE request_id = ?`, reservation.RunID, requestID); err != nil {
			return 0, false, fmt.Errorf("pin gateway usage to run: %w", err)
		}
	}
	return tokens, true, nil
}

// modelCandidates resolves the names a gateway record may carry for the
// reserved model: the internal model ID plus its catalog aliases when the
// authorization port exposes the catalog.
func (s *Store) modelCandidates(ctx context.Context, sid, modelID string) []string {
	candidates := []string{modelID}
	catalog, ok := s.authorizer.(modelCatalogPort)
	if !ok {
		return candidates
	}
	models, err := catalog.ListAuthorized(ctx, sid)
	if err != nil {
		return candidates
	}
	for _, model := range models {
		if model.ID != modelID {
			continue
		}
		for _, alias := range model.Aliases {
			if alias != "" && alias != modelID {
				candidates = append(candidates, alias)
			}
		}
	}
	return candidates
}

// isoWeekStart returns the Monday 00:00 UTC of the ISO week containing at.
func isoWeekStart(at time.Time) time.Time {
	at = at.UTC()
	midnight := time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC)
	weekday := (int(midnight.Weekday()) + 6) % 7 // Monday = 0
	return midnight.AddDate(0, 0, -weekday)
}
