package quota

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type ManagedBudget struct {
	ModelID           string     `json:"modelId"`
	BaseLimitUnits    int64      `json:"baseLimitUnits"`
	Temporary         bool       `json:"temporary"`
	ResetsAt          time.Time  `json:"resetsAt"`
	GatewayAccounting bool       `json:"gatewayAccounting,omitempty"`
	UsageUpdatedAt    *time.Time `json:"usageUpdatedAt,omitempty"`
	Usage
}

func (s *Store) ManagedBudgets(ctx context.Context, sid string, at time.Time) ([]ManagedBudget, error) {
	if at.IsZero() {
		at = s.now()
	}
	rows, err := s.db.QueryContext(ctx, `SELECT model_id, limit_units FROM quota_budgets WHERE sid=? ORDER BY model_id`, sid)
	if err != nil {
		return nil, err
	}
	result := []ManagedBudget{}
	for rows.Next() {
		var b ManagedBudget
		if err = rows.Scan(&b.ModelID, &b.BaseLimitUnits); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, b)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range result {
		b := &result[i]
		if s.gatewayAccounting && b.ModelID != SpeechTranscriptionModelID {
			b.GatewayAccounting = true
			var through int64
			if err := s.db.QueryRowContext(ctx, `SELECT COALESCE((SELECT through_ms FROM quota_gateway_checkpoint WHERE id=1),0)`).Scan(&through); err != nil {
				return nil, err
			}
			if through != 0 {
				updated := time.UnixMilli(through).UTC()
				b.UsageUpdatedAt = &updated
			}
		}
		b.Usage, err = s.Usage(ctx, sid, b.ModelID, at)
		if err != nil {
			return nil, err
		}
		var active int
		err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM quota_overrides WHERE sid=? AND model_id=? AND period=? AND period_key=?`, sid, b.ModelID, b.Period, b.PeriodKey).Scan(&active)
		if err != nil {
			return nil, err
		}
		b.Temporary = active > 0
		utc := at.UTC()
		b.ResetsAt = time.Date(utc.Year(), utc.Month(), utc.Day()+1, 0, 0, 0, 0, time.UTC)
		if Period(b.Period) == Weekly {
			b.ResetsAt = isoWeekStart(at).AddDate(0, 0, 7)
		}
	}
	return result, nil
}

// AdjustBudget changes the total limit without erasing consumed or reserved usage.
// A permanent edit takes effect immediately and replaces any temporary override.
func (s *Store) AdjustBudget(ctx context.Context, sid, modelID, mode string, limit int64, at time.Time) error {
	if limit < 0 || (mode != "temporary" && mode != "permanent" && mode != "restore") {
		return errors.New("invalid quota adjustment")
	}
	if at.IsZero() {
		at = s.now()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var period Period
	err = tx.QueryRowContext(ctx, `SELECT period FROM quota_budgets WHERE sid=? AND model_id=?`, sid, modelID).Scan(&period)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrBudgetNotConfigured
	}
	if err != nil {
		return err
	}
	if mode == "temporary" {
		_, err = tx.ExecContext(ctx, `INSERT INTO quota_overrides(sid,model_id,period,period_key,limit_units) VALUES(?,?,?,?,?) ON CONFLICT(sid,model_id) DO UPDATE SET period=excluded.period,period_key=excluded.period_key,limit_units=excluded.limit_units`, sid, modelID, period, periodKey(period, at), limit)
	} else {
		if mode == "permanent" {
			_, err = tx.ExecContext(ctx, `UPDATE quota_budgets SET limit_units=? WHERE sid=? AND model_id=?`, limit, sid, modelID)
			if err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM quota_overrides WHERE sid=? AND model_id=?`, sid, modelID)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
