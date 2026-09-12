package quota

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"workagent3/internal/audit"
	"workagent3/internal/contracts"
)

var ErrRunNotAccepted = errors.New("quota run was not accepted")

type runAuthorization struct {
	OwnerSID        string
	Scope           string
	Engine          string
	Accepted        bool
	ModelCandidates []string
}

func authorizationByRun(ctx context.Context, q queryer, runID string) (runAuthorization, bool, error) {
	var a runAuthorization
	err := q.QueryRowContext(ctx, `SELECT owner_sid,scope,engine,accepted_at IS NOT NULL FROM quota_run_authorizations WHERE run_id=?`, runID).Scan(&a.OwnerSID, &a.Scope, &a.Engine, &a.Accepted)
	if errors.Is(err, sql.ErrNoRows) {
		return a, false, nil
	}
	return a, err == nil, err
}

func persistRunAuthorization(ctx context.Context, tx *sql.Tx, runID string, a runAuthorization, create bool) error {
	existing, found, err := authorizationByRun(ctx, tx, runID)
	if err != nil {
		return err
	}
	if found {
		if existing.OwnerSID != a.OwnerSID || existing.Scope != a.Scope || existing.Engine != a.Engine {
			return ErrIdempotencyConflict
		}
		return nil
	}
	if !create {
		return ErrReservationNotFound
	}
	candidates, _ := json.Marshal(a.ModelCandidates)
	_, err = tx.ExecContext(ctx, `INSERT INTO quota_run_authorizations(run_id,owner_sid,scope,engine,model_candidates_json) VALUES(?,?,?,?,?)`, runID, a.OwnerSID, a.Scope, a.Engine, string(candidates))
	return err
}

func (s *Store) ReserveSharedRun(ctx context.Context, r contracts.SharedRunQuotaRequest) error {
	if err := validateSID(r.OwnerSID); err != nil {
		return err
	}
	request := ReserveRequest{RunID: r.RunID, SID: r.PayerSID, ModelID: r.ModelID, Engine: r.Engine, EstimatedUnits: r.EstimatedUnits}
	_, replayed, err := s.reserveAuthorized(ctx, request, &runAuthorization{OwnerSID: r.OwnerSID, Scope: "shared", Engine: r.Engine})
	if !replayed {
		s.recordQuotaEvent(ctx, audit.ActionQuotaReserve, r.RunID, r.PayerSID, err, map[string]string{"owner_sid": r.OwnerSID, "model_id": r.ModelID})
	}
	return err
}

// ReserveRuntime only creates a personal reservation. Shared admission exists
// before dispatch; payerSID is checked as a hint, never used as authority.
func (s *Store) ReserveRuntime(ctx context.Context, sid, payerSID string, r ReserveRequest) (Reservation, error) {
	if err := validateSID(sid); err != nil {
		return Reservation{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Reservation{}, err
	}
	defer tx.Rollback()
	existing, found, err := reservationByRun(ctx, tx, r.RunID)
	if err != nil {
		return Reservation{}, err
	}
	if !found {
		if payerSID != "" {
			return Reservation{}, ErrReservationNotFound
		}
		if err := tx.Rollback(); err != nil {
			return Reservation{}, err
		}
		r.SID = sid
		value, replayed, err := s.reserveAuthorized(ctx, r, &runAuthorization{OwnerSID: sid, Scope: "personal", Engine: r.Engine})
		if !replayed {
			s.recordQuotaEvent(ctx, audit.ActionQuotaReserve, r.RunID, sid, err, map[string]string{"model_id": r.ModelID})
		}
		return value, err
	}
	a, authorized, err := authorizationByRun(ctx, tx, r.RunID)
	if err != nil {
		return Reservation{}, err
	}
	if !authorized {
		// The payer alone cannot distinguish a legacy personal run from a
		// shared run executed by someone else. Only trusted recovery can bind it.
		return Reservation{}, ErrReservationNotFound
	}
	if a.OwnerSID != sid || (payerSID != "" && payerSID != existing.SID) {
		return Reservation{}, ErrReservationNotFound
	}
	if existing.ModelID != r.ModelID || existing.ReservedUnits != r.EstimatedUnits || (r.Engine != "" && a.Engine != r.Engine) {
		return Reservation{}, ErrIdempotencyConflict
	}
	if existing.Status == "reserved" {
		existing.AlreadyAccepted = a.Accepted
		if _, err := tx.ExecContext(ctx, `UPDATE quota_run_authorizations SET accepted_at=COALESCE(accepted_at,?) WHERE run_id=?`, s.now().UnixMilli(), r.RunID); err != nil {
			return Reservation{}, err
		}
		// Accounting gets its owner only after the authoritative runtime claim.
		if _, err := tx.ExecContext(ctx, `INSERT INTO quota_gateway_run_owners(run_id,sid) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET sid=excluded.sid`, r.RunID, sid); err != nil {
			return Reservation{}, err
		}
	}
	existing.Accepted = existing.Status == "reserved" || a.Accepted
	if err := tx.Commit(); err != nil {
		return Reservation{}, err
	}
	return existing, nil
}

func (s *Store) LookupRuntimeRun(ctx context.Context, sid, runID string) (Reservation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Reservation{}, err
	}
	defer tx.Rollback()
	r, found, err := reservationByRun(ctx, tx, runID)
	if err != nil {
		return Reservation{}, err
	}
	if !found {
		return Reservation{}, ErrReservationNotFound
	}
	a, authorized, err := authorizationByRun(ctx, tx, runID)
	if err != nil {
		return Reservation{}, err
	}
	if !authorized || a.OwnerSID != sid {
		return Reservation{}, ErrReservationNotFound
	}
	r.Accepted = a.Accepted
	return r, nil
}

func (s *Store) SettleRuntime(ctx context.Context, sid, payerSID string, r SettleRequest) error {
	if err := validateSID(sid); err != nil {
		return err
	}
	// The payer hint is not forwarded as the authorization SID. Owner lookup
	// and settlement happen under the same SQLite transaction in settleAs.
	return s.settleAs(ctx, "", sid, r)
}

func (s *Store) cancelUnacceptedSharedRun(ctx context.Context, payerSID, runID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	r, found, err := reservationByRun(ctx, tx, runID)
	if err != nil {
		return err
	}
	if !found || r.SID != payerSID {
		return ErrReservationNotFound
	}
	a, found, err := authorizationByRun(ctx, tx, runID)
	if err != nil {
		return err
	}
	if !found || a.Scope != "shared" {
		return ErrReservationNotFound
	}
	if r.Status == "settled" {
		return nil
	}
	if a.Accepted {
		return contracts.ErrQuotaRunAccepted
	}
	_, err = tx.ExecContext(ctx, `UPDATE quota_reservations SET status='settled',actual_units=0,settled_at=? WHERE run_id=?`, s.now().Unix(), runID)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// PendingSharedRuns includes legacy reservations only for the trusted Portal
// coordinator to match against the collaboration owner's persisted run facts.
func (s *Store) PendingSharedRuns(ctx context.Context) ([]contracts.PendingQuotaRun, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.run_id,r.sid,COALESCE(a.owner_sid,''),a.run_id IS NULL FROM quota_reservations r LEFT JOIN quota_run_authorizations a ON a.run_id=r.run_id WHERE r.status='reserved' AND (a.scope='shared' OR a.run_id IS NULL)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []contracts.PendingQuotaRun
	for rows.Next() {
		var r contracts.PendingQuotaRun
		if err := rows.Scan(&r.RunID, &r.PayerSID, &r.OwnerSID, &r.Legacy); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// RecoverSharedRunAuthorization binds only existing pending reservations to
// authority supplied by Portal. Old runtime-provided owner values are ignored.
func (s *Store) RecoverSharedRunAuthorization(ctx context.Context, r contracts.SharedRunIdentity) error {
	if err := validateSID(r.OwnerSID); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	reservation, found, err := reservationByRun(ctx, tx, r.RunID)
	if err != nil {
		return err
	}
	if !found || reservation.SID != r.PayerSID {
		return ErrReservationNotFound
	}
	if reservation.Status == "settled" {
		return nil
	}
	a, found, err := authorizationByRun(ctx, tx, r.RunID)
	if err != nil {
		return err
	}
	if found {
		if a.OwnerSID != r.OwnerSID || a.Scope != "shared" || a.Engine != r.Engine {
			return ErrIdempotencyConflict
		}
		return nil
	}
	if err := persistRunAuthorization(ctx, tx, r.RunID, runAuthorization{OwnerSID: r.OwnerSID, Scope: "shared", Engine: r.Engine}, true); err != nil {
		return err
	}
	// We cannot establish whether an old run was dispatched; never zero it.
	if _, err := tx.ExecContext(ctx, `UPDATE quota_run_authorizations SET accepted_at=? WHERE run_id=?`, s.now().UnixMilli(), r.RunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO quota_gateway_run_owners(run_id,sid) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET sid=excluded.sid`, r.RunID, r.OwnerSID); err != nil {
		return err
	}
	return tx.Commit()
}

// ReconcileSettlements retries persisted completed results after a late gateway
// drain or Portal restart. An active run without a completion is never closed.
func (s *Store) ReconcileSettlements(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `SELECT a.run_id,a.owner_sid,a.settlement_units FROM quota_run_authorizations a JOIN quota_reservations r ON r.run_id=a.run_id WHERE r.status='reserved' AND a.settlement_units IS NOT NULL`)
	if err != nil {
		return err
	}
	type pending struct {
		runID, owner string
		units        int64
	}
	var values []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.runID, &p.owner, &p.units); err != nil {
			rows.Close()
			return err
		}
		values = append(values, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var failures []error
	for _, p := range values {
		if err := s.SettleRuntime(ctx, p.owner, "", SettleRequest{RunID: p.runID, ActualUnits: p.units}); err != nil && !errors.Is(err, ErrUsagePending) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
