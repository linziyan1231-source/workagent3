package quota

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"workagent3/internal/contracts"
)

func checkDollarAdmission(ctx context.Context, tx *sql.Tx, r ReserveRequest) (bool, error) {
	pool := "codex"
	if r.Engine == "kimi" || strings.HasPrefix(r.ModelID, "kimi") {
		pool = "kimi"
	}
	var payload string
	err := tx.QueryRowContext(ctx, `SELECT payload FROM quota_dollar_budgets WHERE sid=? AND pool=?`, r.SID, pool).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var b contracts.DollarBudget
	if err = json.Unmarshal([]byte(payload), &b); err != nil {
		return false, err
	}
	if r.At.Sub(b.UpdatedAt) > 15*time.Second {
		return true, ErrUsageStale
	}
	if b.DailyUSD >= b.DailyLimitUSD || b.WeeklyUSD >= b.WeeklyLimitUSD {
		return true, ErrExceeded
	}
	return true, nil
}

func (s *Store) SyncDollarBilling(ctx context.Context, budgets []contracts.DollarBudget, rates []contracts.BillingRate) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, b := range budgets {
		payload, _ := json.Marshal(b)
		if _, err = tx.ExecContext(ctx, `INSERT INTO quota_dollar_budgets(sid,pool,payload) VALUES(?,?,?) ON CONFLICT(sid,pool) DO UPDATE SET payload=excluded.payload`, b.SID, b.Pool, string(payload)); err != nil {
			return err
		}
	}
	for _, r := range rates {
		// Freeze a request's price once. Previously collected history is explicitly an estimate.
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO quota_dollar_usage(request_id,pool,usd,estimated)
SELECT request_id,?,CASE WHEN failed=1 THEN 0 WHEN ?='per_call' THEN ? ELSE
(MAX(0,input_tokens-cached_tokens)*?+output_tokens*?+cached_tokens*?)/1000000.0 END,1
FROM quota_gateway_usage WHERE sid=? AND (model=? OR alias=?)`, r.Pool, r.Mode, r.PerCall, r.Input, r.Output, r.Cache, r.SID, r.Model, r.Model); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) RecordDollarUsage(ctx context.Context, requestID, pool string, usd float64) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO quota_dollar_usage(request_id,pool,usd,estimated) VALUES(?,?,?,1)`, requestID, pool, usd)
	return err
}

func (s *Store) DollarBudgets(ctx context.Context, sid string) ([]contracts.DollarBudget, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT payload FROM quota_dollar_budgets WHERE sid=? ORDER BY pool`, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []contracts.DollarBudget{}
	for rows.Next() {
		var payload string
		if err = rows.Scan(&payload); err != nil {
			return nil, err
		}
		var b contracts.DollarBudget
		if err = json.Unmarshal([]byte(payload), &b); err != nil {
			return nil, err
		}
		result = append(result, b)
	}
	return result, rows.Err()
}

func (s *Store) DollarUsage(ctx context.Context, sid string, from, to time.Time) ([]contracts.DollarUsageRow, error) {
	if !from.Before(to) {
		return nil, errors.New("invalid usage interval")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT COALESCE(r.sid,g.sid),COALESCE(d.pool,'unknown'),COALESCE(SUM(d.usd),0),COUNT(*),SUM(CASE WHEN d.request_id IS NULL THEN 1 ELSE 0 END),COALESCE(SUM(d.estimated),0)
FROM quota_gateway_usage g LEFT JOIN quota_dollar_usage d ON d.request_id=g.request_id LEFT JOIN quota_reservations r ON r.run_id=g.matched_run_id
WHERE occurred_at>=? AND occurred_at<? AND (?='' OR COALESCE(r.sid,g.sid)=?)
GROUP BY COALESCE(r.sid,g.sid),COALESCE(d.pool,'unknown') ORDER BY 1,2`, from.Unix(), to.Unix(), sid, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []contracts.DollarUsageRow{}
	for rows.Next() {
		var r contracts.DollarUsageRow
		if err = rows.Scan(&r.SID, &r.Pool, &r.USD, &r.Requests, &r.Unpriced, &r.Estimated); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}
