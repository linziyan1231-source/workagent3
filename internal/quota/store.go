package quota

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
)

var (
	ErrBudgetNotConfigured = contracts.ErrQuotaNotConfigured
	ErrExceeded            = contracts.ErrQuotaExceeded
	ErrIdempotencyConflict = errors.New("quota idempotency conflict")
	ErrReservationNotFound = errors.New("quota reservation not found")
	ErrModelUnauthorized   = contracts.ErrModelUnauthorized
)

const SpeechTranscriptionModelID = "speech-transcription"

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
	Engine         string
}

type Reservation struct {
	RunID         string `json:"runId"`
	SID           string `json:"sid"`
	ModelID       string `json:"modelId"`
	Period        Period `json:"period"`
	PeriodKey     string `json:"periodKey"`
	ReservedUnits int64  `json:"reservedUnits"`
	ActualUnits   *int64 `json:"actualUnits"`
	Status        string `json:"status"`
}

type SettleRequest struct {
	RunID       string
	ActualUnits int64
}

type Usage = contracts.QuotaUsage

type Store struct {
	db                *sql.DB
	authorizer        ModelAuthorizationPort
	audit             audit.Sink
	now               func() time.Time
	gatewayAccounting bool
}

// SetAudit wires the business audit sink for quota reserve/settle events. The
// run ID doubles as the correlation ID so a reserve and its settle share one
// audit trail; the actor is the paying SID (the frozen payer for shared
// runs). Recording never fails the quota operation itself.
func (s *Store) SetAudit(sink audit.Sink) {
	s.audit = sink
}

func Open(path string, authorizer ModelAuthorizationPort) (*Store, error) {
	if authorizer == nil {
		return nil, errors.New("quota model authorization port is required")
	}
	return open(path, authorizer)
}

// OpenRecorder opens the quota database for the Employee Manager usage drain,
// which indexes gateway keys and records gateway usage but never reserves or
// settles. The Portal holds the reserving store over the same database file;
// both processes coordinate through SQLite with a busy timeout.
func OpenRecorder(path string) (*Store, error) {
	return open(path, nil)
}

func open(path string, authorizer ModelAuthorizationPort) (*Store, error) {
	// Reserve and settle read before writing. Acquire the write reservation at
	// BEGIN so a concurrent usage recorder cannot cause a lock-upgrade failure;
	// busy_timeout alone cannot wait out that SQLite deadlock.
	database, err := sql.Open("sqlite", path+"?_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
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
CREATE TABLE IF NOT EXISTS quota_overrides (
  sid TEXT NOT NULL,
  model_id TEXT NOT NULL,
  period TEXT NOT NULL,
  period_key TEXT NOT NULL,
  limit_units INTEGER NOT NULL CHECK (limit_units >= 0),
  PRIMARY KEY (sid, model_id),
  FOREIGN KEY (sid, model_id) REFERENCES quota_budgets(sid, model_id)
);
CREATE TABLE IF NOT EXISTS quota_gateway_keys (
  key_id TEXT PRIMARY KEY CHECK (key_id <> ''),
  sid TEXT NOT NULL CHECK (sid LIKE 'S-1-%'),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_gateway_usage (
  request_id TEXT PRIMARY KEY,
  sid TEXT NOT NULL CHECK (sid LIKE 'S-1-%'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  alias TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  cached_tokens INTEGER NOT NULL CHECK (cached_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  occurred_at INTEGER NOT NULL,
  drained_at INTEGER NOT NULL,
  matched_run_id TEXT
);
CREATE INDEX IF NOT EXISTS quota_gateway_usage_match
ON quota_gateway_usage(sid, failed, matched_run_id, occurred_at);
CREATE TABLE IF NOT EXISTS quota_gateway_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), through_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quota_gateway_holds (run_id TEXT PRIMARY KEY REFERENCES quota_reservations(run_id), release_after_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quota_gateway_run_owners (run_id TEXT PRIMARY KEY REFERENCES quota_reservations(run_id), sid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quota_dollar_budgets (sid TEXT NOT NULL,pool TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(sid,pool));
CREATE TABLE IF NOT EXISTS quota_dollar_usage (request_id TEXT PRIMARY KEY,pool TEXT NOT NULL,usd REAL NOT NULL,estimated INTEGER NOT NULL);
`)
	if err != nil {
		return fmt.Errorf("migrate quota database: %w", err)
	}
	// The first drain design indexed SHA-256 digests of plaintext keys, but
	// deployed gateway records carry the opaque key ID instead, making digest
	// rows unmappable. Drop such a legacy table and rebuild it keyed by ID;
	// keys are re-indexed on the next provision or repair.
	var legacyDigest int
	if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM pragma_table_info('quota_gateway_keys') WHERE name = 'key_digest'`).Scan(&legacyDigest); err != nil {
		return fmt.Errorf("inspect gateway key index schema: %w", err)
	}
	if legacyDigest > 0 {
		if _, err := s.db.ExecContext(ctx, `
DROP TABLE quota_gateway_keys;
CREATE TABLE quota_gateway_keys (
  key_id TEXT PRIMARY KEY CHECK (key_id <> ''),
  sid TEXT NOT NULL CHECK (sid LIKE 'S-1-%'),
  created_at INTEGER NOT NULL
);`); err != nil {
			return fmt.Errorf("rebuild gateway key index: %w", err)
		}
	}
	// settle_source ('gateway' | 'estimated') records whether a settlement used
	// authoritative gateway tokens or the caller's conservative estimate.
	var columnCount int
	if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM pragma_table_info('quota_reservations') WHERE name = 'settle_source'`).Scan(&columnCount); err != nil {
		return fmt.Errorf("inspect quota reservations schema: %w", err)
	}
	if columnCount == 0 {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE quota_reservations ADD COLUMN settle_source TEXT CHECK (settle_source IN ('gateway', 'estimated'))`); err != nil {
			return fmt.Errorf("add quota settlement source column: %w", err)
		}
	}
	return nil
}

func (s *Store) SetBudget(ctx context.Context, budget Budget) error {
	if err := validateBudget(budget); err != nil {
		return err
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

// EnsureBudget inserts the budget only when none exists for the (SID, model)
// pair, so provisioning/repair replays never overwrite a later administrator
// adjustment (SetBudget remains the authoritative overwrite path).
func (s *Store) EnsureBudget(ctx context.Context, budget Budget) error {
	if err := validateBudget(budget); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO quota_budgets(sid, model_id, period, limit_units) VALUES(?, ?, ?, ?)
ON CONFLICT(sid, model_id) DO NOTHING`,
		budget.SID, budget.ModelID, budget.Period, budget.LimitUnits)
	if err != nil {
		return fmt.Errorf("ensure quota budget: %w", err)
	}
	return nil
}

func validateBudget(budget Budget) error {
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
	return nil
}

// Reserve audits the business outcome of every fresh reservation attempt
// (success, denial, or failure); idempotent replays of an existing
// reservation are not new business events and are not recorded.
func (s *Store) Reserve(ctx context.Context, request ReserveRequest) (Reservation, error) {
	reservation, replayed, err := s.reserve(ctx, request)
	if !replayed && strings.TrimSpace(request.RunID) != "" {
		s.recordQuotaEvent(ctx, audit.ActionQuotaReserve, request.RunID, request.SID, err, map[string]string{
			"model_id": request.ModelID, "estimated_units": strconv.FormatInt(request.EstimatedUnits, 10),
		})
	}
	return reservation, err
}

func (s *Store) reserve(ctx context.Context, request ReserveRequest) (Reservation, bool, error) {
	if err := validateReserve(request); err != nil {
		return Reservation{}, false, err
	}
	if s.authorizer == nil {
		return Reservation{}, false, errors.New("quota model authorization port is required")
	}
	authorized, err := s.authorizer.Authorized(ctx, request.SID, request.ModelID)
	if err != nil {
		return Reservation{}, false, fmt.Errorf("authorize quota model: %w", err)
	}
	if !authorized {
		return Reservation{}, false, ErrModelUnauthorized
	}
	if request.At.IsZero() {
		request.At = s.now()
	}
	var scopes []accountingScope
	if s.gatewayAccounting && request.ModelID != SpeechTranscriptionModelID {
		scopes, err = s.accountingScopes(ctx, request.SID)
		if err != nil {
			return Reservation{}, false, err
		}
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return Reservation{}, false, fmt.Errorf("begin quota reservation: %w", err)
	}
	defer tx.Rollback()

	if existing, found, err := reservationByRun(ctx, tx, request.RunID); err != nil {
		return Reservation{}, false, err
	} else if found {
		if existing.SID != request.SID || existing.ModelID != request.ModelID || existing.ReservedUnits != request.EstimatedUnits {
			return Reservation{}, true, ErrIdempotencyConflict
		}
		return existing, true, nil
	}

	period, limit, err := budgetFor(ctx, tx, request.SID, request.ModelID, request.At)
	if err != nil {
		return Reservation{}, false, err
	}
	key := periodKey(period, request.At)
	usage, err := usageFor(ctx, tx, request.SID, request.ModelID, period, key, limit)
	if err != nil {
		return Reservation{}, false, err
	}
	if usage.ConsumedUnits+usage.ReservedUnits+request.EstimatedUnits > limit {
		if !s.gatewayAccounting || request.ModelID == SpeechTranscriptionModelID {
			return Reservation{}, false, ErrExceeded
		}
	}
	if s.gatewayAccounting && request.ModelID != SpeechTranscriptionModelID {
		if err := ensureGatewayFresh(ctx, tx, request.SID, request.At); err != nil {
			return Reservation{}, false, err
		}

		// Once synchronized, monetary gateway pools replace legacy per-model token caps.
		dollarChecked, err := checkDollarAdmission(ctx, tx, request)
		if err != nil {
			return Reservation{}, false, err
		}
		checked := dollarChecked
		for _, scope := range scopes {
			if dollarChecked {
				checked = true
				break
			}
			if (scope.id == "harness-default" && request.Engine != "harness" && request.ModelID != "harness-default") || (scope.id == "codex-native" && (request.Engine == "harness" || request.ModelID == "harness-default")) {
				continue
			}
			if scope.id != request.ModelID && !slices.Contains(scope.models, request.ModelID) {
				continue
			}
			p, cap, err := budgetFor(ctx, tx, request.SID, scope.id, request.At)
			if errors.Is(err, ErrBudgetNotConfigured) && scope.id != request.ModelID {
				continue
			}
			if err != nil {
				return Reservation{}, false, err
			}
			actual, err := gatewayUsageFor(ctx, tx, request.SID, scope, p, request.At, cap)
			if err != nil {
				return Reservation{}, false, err
			}
			if actual.ConsumedUnits+actual.ReservedUnits >= cap || actual.ConsumedUnits+actual.ReservedUnits+request.EstimatedUnits > cap {
				return Reservation{}, false, ErrExceeded
			}
			checked = true
		}
		if !checked {
			return Reservation{}, false, ErrBudgetNotConfigured
		}
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
		return Reservation{}, false, fmt.Errorf("persist quota reservation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Reservation{}, false, fmt.Errorf("commit quota reservation: %w", err)
	}
	return reservation, false, nil
}

// recordQuotaEvent writes one business audit event for a quota operation. The
// run ID doubles as the correlation ID so a reserve and its settle share one
// trail. Recording never fails the operation, matching the Portal middleware
// policy.
func (s *Store) recordQuotaEvent(ctx context.Context, action, runID, sid string, operation error, metadata map[string]string) {
	if s.audit == nil {
		return
	}
	result := "success"
	if operation != nil {
		result = "failure"
		if errors.Is(operation, ErrExceeded) || errors.Is(operation, ErrModelUnauthorized) {
			result = "denied"
		}
	}
	_, _ = s.audit.Record(context.WithoutCancel(ctx), contracts.AuditInput{
		Actor: sid, Target: runID, Action: action, Result: result, CorrelationID: runID, Metadata: metadata,
	})
}

func (s *Store) Settle(ctx context.Context, request SettleRequest) error {
	return s.settle(ctx, "", request)
}

// ReserveForSID prevents a scoped Runtime credential from reserving quota for
// another employee: the pinned SID must match the request SID. The Portal uses
// it to pin shared-run reservations to the frozen payer (the member who
// mentioned the assistant), which may differ from the runtime owner's SID.
func (s *Store) ReserveForSID(ctx context.Context, sid string, request ReserveRequest) (Reservation, error) {
	if err := validateSID(sid); err != nil {
		return Reservation{}, err
	}
	if request.SID != sid {
		return Reservation{}, errors.New("quota reservation SID mismatch")
	}
	return s.Reserve(ctx, request)
}

// ReserveSharedRun exposes a narrow resource-specific Port to the Portal for
// shared AI runs: the reservation is pinned to the frozen payer SID at
// admission, before the owner Runtime starts the turn.
func (s *Store) ReserveSharedRun(ctx context.Context, sid, runID, modelID, engine string, estimatedUnits int64) error {
	_, err := s.ReserveForSID(ctx, sid, ReserveRequest{
		RunID: runID, SID: sid, ModelID: modelID, EstimatedUnits: estimatedUnits, Engine: engine,
	})
	return err
}

// ReleaseSharedRun settles a shared run admission reservation with zero
// actual units when the run failed before reaching the owner Runtime.
// Settlement is idempotent: when the runtime-side runner already settled the
// reservation, a repeated settle is either a no-op (same zero units) or an
// idempotency conflict the caller may ignore.
func (s *Store) ReleaseSharedRun(ctx context.Context, sid, runID string) error {
	return s.SettleForSID(ctx, sid, SettleRequest{RunID: runID, ActualUnits: 0})
}

// SettleForSID prevents a scoped Runtime credential from settling another
// employee's reservation even if it learns a run ID.
func (s *Store) SettleForSID(ctx context.Context, sid string, request SettleRequest) error {
	if err := validateSID(sid); err != nil {
		return err
	}
	return s.settle(ctx, sid, request)
}

// ReserveSpeech and SettleSpeech expose a narrow resource-specific Port to the
// Portal. Speech never receives the Quota store or its database and cannot
// choose a different model/accounting bucket.
func (s *Store) ReserveSpeech(ctx context.Context, sid, runID string, estimatedSeconds int64) error {
	_, err := s.Reserve(ctx, ReserveRequest{
		RunID: runID, SID: sid, ModelID: SpeechTranscriptionModelID, EstimatedUnits: estimatedSeconds,
	})
	return err
}

func (s *Store) SettleSpeech(ctx context.Context, runID string, actualSeconds int64) error {
	return s.Settle(ctx, SettleRequest{RunID: runID, ActualUnits: actualSeconds})
}

func (s *Store) settle(ctx context.Context, sid string, request SettleRequest) (err error) {
	if strings.TrimSpace(request.RunID) == "" {
		return errors.New("quota run ID is required")
	}
	if request.ActualUnits < 0 {
		return errors.New("actual quota usage cannot be negative")
	}
	// The audit actor is the paying SID: the pinned one when scoped, otherwise
	// the reservation owner once loaded. An idempotent replay of an unchanged
	// settlement is not a new business event and stays unrecorded.
	actor := sid
	metadata := map[string]string{"actual_units": strconv.FormatInt(request.ActualUnits, 10)}
	record := true
	defer func() {
		if record {
			if actor == "" {
				actor = "quota"
			}
			s.recordQuotaEvent(ctx, audit.ActionQuotaSettle, request.RunID, actor, err, metadata)
		}
	}()
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
	if actor == "" {
		actor = reservation.SID
	}
	metadata["model_id"] = reservation.ModelID
	if sid != "" && reservation.SID != sid {
		return ErrReservationNotFound
	}
	if reservation.Status == "settled" {
		if s.gatewayAccounting && reservation.ModelID != SpeechTranscriptionModelID {
			record = false
			return nil
		}
		if reservation.ActualUnits != nil && *reservation.ActualUnits == request.ActualUnits {
			record = false
			return nil
		}
		return ErrIdempotencyConflict
	}
	actual := request.ActualUnits
	var source string
	var gatewayOwner string
	if s.gatewayAccounting && reservation.ModelID != SpeechTranscriptionModelID {
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT sid FROM quota_gateway_run_owners WHERE run_id=?),?)`, reservation.RunID, reservation.SID).Scan(&gatewayOwner); err != nil {
			return err
		}
		if gatewayOwner != reservation.SID {
			// Shared turns cannot move charges to the frozen payer until the
			// owner's completed requests have reached the ledger.
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO quota_gateway_holds(run_id,release_after_ms) VALUES(?,?)`, reservation.RunID, s.now().UnixMilli()); err != nil {
				return err
			}
			var ready bool
			if err := tx.QueryRowContext(ctx, `SELECT release_after_ms <= COALESCE((SELECT through_ms FROM quota_gateway_checkpoint WHERE id=1),0) FROM quota_gateway_holds WHERE run_id=?`, reservation.RunID).Scan(&ready); err != nil {
				return err
			}
			if !ready {
				if err := tx.Commit(); err != nil {
					return err
				}
				return ErrUsagePending
			}
		}
	}
	if reservation.ModelID != SpeechTranscriptionModelID && (!s.gatewayAccounting || gatewayOwner != reservation.SID) {
		// Authoritative settlement prefers real tokens from the drained gateway
		// usage detail (matched by SID + time window + model); without a match
		// the caller's conservative estimate stands and is marked estimated.
		tokens, matched, matchErr := s.matchGatewayUsage(ctx, tx, reservation)
		if matchErr != nil {
			return matchErr
		}
		source = "estimated"
		if matched {
			actual = tokens
			source = "gateway"
		}
		metadata["actual_units"] = strconv.FormatInt(actual, 10)
		metadata["settle_source"] = source
	}
	var sourceColumn any
	if source != "" {
		sourceColumn = source
	}
	_, err = tx.ExecContext(ctx, `
UPDATE quota_reservations SET status = 'settled', actual_units = ?, settled_at = ?, settle_source = ?
WHERE run_id = ? AND status = 'reserved'`, actual, s.now().Unix(), sourceColumn, request.RunID)
	if err != nil {
		return fmt.Errorf("settle quota reservation: %w", err)
	}
	if s.gatewayAccounting && reservation.ModelID != SpeechTranscriptionModelID {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO quota_gateway_holds(run_id,release_after_ms) VALUES(?,?)`, reservation.RunID, s.now().UnixMilli()); err != nil {
			return err
		}
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
	period, limit, err := budgetFor(ctx, s.db, sid, modelID, at)
	if err != nil {
		return Usage{}, err
	}
	if s.gatewayAccounting && modelID != SpeechTranscriptionModelID {
		scopes, err := s.accountingScopes(ctx, sid)
		if err != nil {
			return Usage{}, err
		}
		for _, scope := range scopes {
			if scope.id == modelID {
				return gatewayUsageFor(ctx, s.db, sid, scope, period, at, limit)
			}
		}
		return Usage{}, ErrModelUnauthorized
	}
	return usageFor(ctx, s.db, sid, modelID, period, periodKey(period, at), limit)
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func budgetFor(ctx context.Context, q queryer, sid, modelID string, at time.Time) (Period, int64, error) {
	var period Period
	var limit int64
	err := q.QueryRowContext(ctx, `
SELECT b.period, COALESCE(o.limit_units, b.limit_units) FROM quota_budgets b
LEFT JOIN quota_overrides o ON o.sid=b.sid AND o.model_id=b.model_id AND o.period=b.period
 AND o.period_key=CASE b.period WHEN 'daily' THEN ? ELSE ? END
WHERE b.sid = ? AND b.model_id = ?`, periodKey(Daily, at), periodKey(Weekly, at), sid, modelID).Scan(&period, &limit)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, ErrBudgetNotConfigured
	}
	if err != nil {
		return "", 0, fmt.Errorf("read quota budget: %w", err)
	}
	return period, limit, nil
}

func usageFor(ctx context.Context, q queryer, sid, modelID string, period Period, key string, limit int64) (Usage, error) {
	usage := Usage{LimitUnits: limit, Period: string(period), PeriodKey: key}
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
	if request.Engine != "" && request.Engine != "codex" && request.Engine != "kimi" && request.Engine != "harness" {
		return errors.New("invalid quota engine")
	}
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
