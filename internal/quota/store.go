package quota

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrBudgetNotConfigured = errors.New("quota budget is not configured")
	ErrExceeded            = errors.New("quota exceeded")
	ErrIdempotencyConflict = errors.New("quota idempotency conflict")
	ErrReservationNotFound = errors.New("quota reservation not found")
	ErrModelUnauthorized   = errors.New("model is not authorized")
)

type ModelAuthorizationPort interface {
	Authorized(ctx context.Context, sid, modelID string) (bool, error)
}

type Period string

const (
	Daily  Period = "daily"
	Weekly Period = "weekly"
)

type Budget struct {
	SID        string
	ModelID    string
	Period     Period
	LimitUnits int64
}

type ReserveRequest struct {
	RunID          string
	SID            string
	ModelID        string
	EstimatedUnits int64
	At             time.Time
}

type Reservation struct {
	RunID         string
	SID           string
	ModelID       string
	Period        Period
	PeriodKey     string
	ReservedUnits int64
	ActualUnits   *int64
	Status        string
}

type SettleRequest struct {
	RunID       string
	ActualUnits int64
}

type Usage struct {
	LimitUnits    int64
	ConsumedUnits int64
	ReservedUnits int64
}

type Store struct {
	db         *sql.DB
	authorizer ModelAuthorizationPort
	now        func() time.Time
}

func Open(path string, authorizer ModelAuthorizationPort) (*Store, error) {
	if authorizer == nil {
		return nil, errors.New("quota model authorization port is required")
	}
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open quota database: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database, authorizer: authorizer, now: time.Now}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS quota_budgets (
  sid TEXT NOT NULL CHECK (sid LIKE 'S-1-%'),
  model_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly')),
  limit_units INTEGER NOT NULL CHECK (limit_units >= 0),
  PRIMARY KEY (sid, model_id)
);
CREATE TABLE IF NOT EXISTS quota_reservations (
  run_id TEXT PRIMARY KEY,
  sid TEXT NOT NULL CHECK (sid LIKE 'S-1-%'),
  model_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly')),
  period_key TEXT NOT NULL,
  reserved_units INTEGER NOT NULL CHECK (reserved_units >= 0),
  actual_units INTEGER CHECK (actual_units >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS quota_reservations_window
ON quota_reservations(sid, model_id, period, period_key, status);
`)
	if err != nil {
		return fmt.Errorf("migrate quota database: %w", err)
	}
	return nil
}

func (s *Store) SetBudget(ctx context.Context, budget Budget) error {
	if err := validateSID(budget.SID); err != nil {
		return err
	}
	if strings.TrimSpace(budget.ModelID) == "" {
		return errors.New("quota model ID is required")
	}
	if budget.Period != Daily && budget.Period != Weekly {
		return errors.New("quota period is invalid")
	}
	if budget.LimitUnits < 0 {
		return errors.New("quota limit cannot be negative")
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO quota_budgets(sid, model_id, period, limit_units) VALUES(?, ?, ?, ?)
ON CONFLICT(sid, model_id) DO UPDATE SET period = excluded.period, limit_units = excluded.limit_units`,
		budget.SID, budget.ModelID, budget.Period, budget.LimitUnits)
	if err != nil {
		return fmt.Errorf("set quota budget: %w", err)
	}
	return nil
}

func (s *Store) Reserve(ctx context.Context, request ReserveRequest) (Reservation, error) {
	if err := validateReserve(request); err != nil {
		return Reservation{}, err
	}
	authorized, err := s.authorizer.Authorized(ctx, request.SID, request.ModelID)
	if err != nil {
		return Reservation{}, fmt.Errorf("authorize quota model: %w", err)
	}
	if !authorized {
		return Reservation{}, ErrModelUnauthorized
	}
	if request.At.IsZero() {
		request.At = s.now()
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return Reservation{}, fmt.Errorf("begin quota reservation: %w", err)
	}
	defer tx.Rollback()

	if existing, found, err := reservationByRun(ctx, tx, request.RunID); err != nil {
		return Reservation{}, err
	} else if found {
		if existing.SID != request.SID || existing.ModelID != request.ModelID || existing.ReservedUnits != request.EstimatedUnits {
			return Reservation{}, ErrIdempotencyConflict
		}
		return existing, nil
	}

	period, limit, err := budgetFor(ctx, tx, request.SID, request.ModelID)
	if err != nil {
		return Reservation{}, err
	}
	key := periodKey(period, request.At)
	usage, err := usageFor(ctx, tx, request.SID, request.ModelID, period, key, limit)
	if err != nil {
		return Reservation{}, err
	}
	if usage.ConsumedUnits+usage.ReservedUnits+request.EstimatedUnits > limit {
		return Reservation{}, ErrExceeded
	}
	reservation := Reservation{
		RunID: request.RunID, SID: request.SID, ModelID: request.ModelID,
		Period: period, PeriodKey: key, ReservedUnits: request.EstimatedUnits, Status: "reserved",
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO quota_reservations(run_id, sid, model_id, period, period_key, reserved_units, status, created_at)
VALUES(?, ?, ?, ?, ?, ?, 'reserved', ?)`, request.RunID, request.SID, request.ModelID,
		period, key, request.EstimatedUnits, request.At.Unix())
	if err != nil {
		return Reservation{}, fmt.Errorf("persist quota reservation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Reservation{}, fmt.Errorf("commit quota reservation: %w", err)
	}
	return reservation, nil
}

func (s *Store) Settle(ctx context.Context, request SettleRequest) error {
	if strings.TrimSpace(request.RunID) == "" {
		return errors.New("quota run ID is required")
	}
	if request.ActualUnits < 0 {
		return errors.New("actual quota usage cannot be negative")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return fmt.Errorf("begin quota settlement: %w", err)
	}
	defer tx.Rollback()
	reservation, found, err := reservationByRun(ctx, tx, request.RunID)
	if err != nil {
		return err
	}
	if !found {
		return ErrReservationNotFound
	}
	if reservation.Status == "settled" {
		if reservation.ActualUnits != nil && *reservation.ActualUnits == request.ActualUnits {
			return nil
		}
		return ErrIdempotencyConflict
	}
	_, err = tx.ExecContext(ctx, `
UPDATE quota_reservations SET status = 'settled', actual_units = ?, settled_at = ?
WHERE run_id = ? AND status = 'reserved'`, request.ActualUnits, s.now().Unix(), request.RunID)
	if err != nil {
		return fmt.Errorf("settle quota reservation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit quota settlement: %w", err)
	}
	return nil
}

func (s *Store) Usage(ctx context.Context, sid, modelID string, at time.Time) (Usage, error) {
	if at.IsZero() {
		at = s.now()
	}
	period, limit, err := budgetFor(ctx, s.db, sid, modelID)
	if err != nil {
		return Usage{}, err
	}
	return usageFor(ctx, s.db, sid, modelID, period, periodKey(period, at), limit)
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func budgetFor(ctx context.Context, q queryer, sid, modelID string) (Period, int64, error) {
	var period Period
	var limit int64
	err := q.QueryRowContext(ctx, `
SELECT period, limit_units FROM quota_budgets WHERE sid = ? AND model_id = ?
ORDER BY CASE period WHEN 'daily' THEN 0 ELSE 1 END LIMIT 1`, sid, modelID).Scan(&period, &limit)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, ErrBudgetNotConfigured
	}
	if err != nil {
		return "", 0, fmt.Errorf("read quota budget: %w", err)
	}
	return period, limit, nil
}

func usageFor(ctx context.Context, q queryer, sid, modelID string, period Period, key string, limit int64) (Usage, error) {
	usage := Usage{LimitUnits: limit}
	err := q.QueryRowContext(ctx, `
SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_units ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_units ELSE 0 END), 0)
FROM quota_reservations WHERE sid = ? AND model_id = ? AND period = ? AND period_key = ?`,
		sid, modelID, period, key).Scan(&usage.ConsumedUnits, &usage.ReservedUnits)
	if err != nil {
		return Usage{}, fmt.Errorf("read quota usage: %w", err)
	}
	return usage, nil
}

func reservationByRun(ctx context.Context, q queryer, runID string) (Reservation, bool, error) {
	var value Reservation
	var actual sql.NullInt64
	err := q.QueryRowContext(ctx, `
SELECT run_id, sid, model_id, period, period_key, reserved_units, actual_units, status
FROM quota_reservations WHERE run_id = ?`, runID).Scan(&value.RunID, &value.SID, &value.ModelID,
		&value.Period, &value.PeriodKey, &value.ReservedUnits, &actual, &value.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return Reservation{}, false, nil
	}
	if err != nil {
		return Reservation{}, false, fmt.Errorf("read quota reservation: %w", err)
	}
	if actual.Valid {
		value.ActualUnits = &actual.Int64
	}
	return value, true, nil
}

func periodKey(period Period, at time.Time) string {
	at = at.UTC()
	if period == Weekly {
		year, week := at.ISOWeek()
		return fmt.Sprintf("%04d-W%02d", year, week)
	}
	return at.Format("2006-01-02")
}

func validateSID(sid string) error {
	if !strings.HasPrefix(sid, "S-1-") {
		return errors.New("quota SID is invalid")
	}
	return nil
}

func validateReserve(request ReserveRequest) error {
	if strings.TrimSpace(request.RunID) == "" {
		return errors.New("quota run ID is required")
	}
	if err := validateSID(request.SID); err != nil {
		return err
	}
	if strings.TrimSpace(request.ModelID) == "" {
		return errors.New("quota model ID is required")
	}
	if request.EstimatedUnits < 0 {
		return errors.New("reserved quota usage cannot be negative")
	}
	return nil
}
