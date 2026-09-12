package quota

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

var (
	ErrUsageStale   = errors.New("gateway usage is unavailable or stale")
	ErrUsagePending = errors.New("gateway usage settlement is pending")
)

// UseGatewayAccounting makes the gateway request ledger the single source of
// consumed model tokens. Reservations are admission holds, never another copy
// of the same consumption. Speech continues to use its seconds ledger.
func (s *Store) UseGatewayAccounting() { s.gatewayAccounting = true }

// MarkGatewayDrained advances only after the consumer persisted a complete
// queue read. The start time, not the finish time, is the completeness boundary.
func (s *Store) MarkGatewayDrained(ctx context.Context, started time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO quota_gateway_checkpoint(id, through_ms) VALUES(1, ?)
ON CONFLICT(id) DO UPDATE SET through_ms=MAX(through_ms, excluded.through_ms)`, started.UnixMilli())
	return err
}

type accountingScope struct {
	id     string
	models []string
}

// Logical engine budgets are shared model pools: the upstream key cannot
// distinguish Harness from native Codex. Concrete model budgets are additional
// caps, not extra allowances that can be added to the pool.
func (s *Store) accountingScopes(ctx context.Context, sid string) ([]accountingScope, error) {
	catalog, ok := s.authorizer.(modelCatalogPort)
	if !ok {
		return nil, errors.New("gateway accounting requires the model catalog")
	}
	models, err := catalog.ListAuthorized(ctx, sid)
	if err != nil {
		return nil, err
	}
	result := make([]accountingScope, 0, len(models))
	for _, m := range models {
		candidates := []string{m.ID}
		candidates = append(candidates, m.Aliases...)
		provider := ""
		switch m.ID {
		case "codex-native", "harness-default":
			provider = "codex"
		case "kimi-native":
			provider = "kimi"
		}
		if provider != "" {
			if provider == "codex" {
				candidates = append(candidates, "harness-default", "codex-native")
			}
			for _, actual := range models {
				if actual.ProviderID == provider {
					candidates = append(candidates, actual.ID)
					candidates = append(candidates, actual.Aliases...)
				}
			}
		}
		slices.Sort(candidates)
		result = append(result, accountingScope{m.ID, slices.Compact(candidates)})
	}
	return result, nil
}

func gatewayPeriodStart(period Period, at time.Time) time.Time {
	if period == Weekly {
		return isoWeekStart(at)
	}
	at = at.UTC()
	return time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC)
}

func gatewayUsageFor(ctx context.Context, q queryer, sid string, scope accountingScope, period Period, at time.Time, limit int64) (Usage, error) {
	usage := Usage{LimitUnits: limit, Period: string(period), PeriodKey: periodKey(period, at)}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(scope.models)), ",")
	args := []any{sid, gatewayPeriodStart(period, at).Unix(), at.Unix()}
	for i := 0; i < 2; i++ {
		for _, model := range scope.models {
			args = append(args, model)
		}
	}
	// Include usage even when a request ended with cancellation or failure:
	// provider-reported nonzero tokens have already been consumed.
	err := q.QueryRowContext(ctx, fmt.Sprintf(`SELECT COALESCE(SUM(total_tokens),0)
FROM quota_gateway_usage g LEFT JOIN quota_reservations r ON r.run_id=g.matched_run_id
WHERE COALESCE(r.sid,g.sid)=? AND occurred_at>=? AND occurred_at<=?
AND (g.model IN (%s) OR g.alias IN (%s))`, marks, marks), args...).Scan(&usage.ConsumedUnits)
	if err != nil {
		return Usage{}, err
	}
	// ACP agents may use employee-owned API credentials outside the gateway.
	// Their explicitly estimated ledger must remain visible alongside gateway usage.
	estimateArgs := []any{sid, string(period), periodKey(period, at)}
	for _, model := range scope.models {
		estimateArgs = append(estimateArgs, model)
	}
	var estimated int64
	if err := q.QueryRowContext(ctx, fmt.Sprintf(`SELECT COALESCE(SUM(actual_units),0) FROM quota_reservations WHERE sid=? AND period=? AND period_key=? AND engine='acp' AND status='settled' AND model_id IN (%s)`, marks), estimateArgs...).Scan(&estimated); err != nil {
		return Usage{}, err
	}
	usage.ConsumedUnits += estimated
	args = []any{sid}
	for _, model := range scope.models {
		args = append(args, model)
	}
	err = q.QueryRowContext(ctx, fmt.Sprintf(`SELECT COALESCE(SUM(r.reserved_units),0)
FROM quota_reservations r WHERE r.sid=? AND r.model_id IN (%s)
AND (r.status='reserved' OR EXISTS(SELECT 1 FROM quota_gateway_holds h WHERE h.run_id=r.run_id
AND h.release_after_ms > COALESCE((SELECT through_ms FROM quota_gateway_checkpoint WHERE id=1),0)))`, marks), args...).Scan(&usage.ReservedUnits)
	return usage, err
}

func ensureGatewayFresh(ctx context.Context, q queryer, sid string, at time.Time) error {
	var through int64
	if err := q.QueryRowContext(ctx, `SELECT COALESCE((SELECT through_ms FROM quota_gateway_checkpoint WHERE id=1),0)`).Scan(&through); err != nil {
		return err
	}
	if at.UnixMilli()-through > (10 * time.Second).Milliseconds() {
		return ErrUsageStale
	}
	var pending int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM quota_gateway_holds h
JOIN quota_reservations r ON r.run_id=h.run_id WHERE r.sid=? AND h.release_after_ms>?`, sid, through).Scan(&pending); err != nil {
		return err
	}
	if pending > 0 {
		return ErrUsagePending
	}
	return nil
}
