package collaboration

import (
	"context"
	"database/sql"
	"errors"
	"workagent3/internal/contracts"
)

// QuotaRunIdentity reads the original execution and payer facts, not today's
// membership or project owner. Only Portal's recovery coordinator consumes it.
func (s *Store) QuotaRunIdentity(ctx context.Context, runID string) (contracts.SharedRunIdentity, error) {
	var value contracts.SharedRunIdentity
	err := s.db.QueryRowContext(ctx, `SELECT r.id,r.owner_sid,p.sid,r.engine,r.state FROM shared_ai_runs r JOIN shared_ai_run_payers p ON p.run_id=r.id WHERE r.id=? AND p.share_denominator=1 AND (SELECT COUNT(*) FROM shared_ai_run_payers WHERE run_id=r.id)=1`, runID).Scan(&value.RunID, &value.OwnerSID, &value.PayerSID, &value.Engine, &value.State)
	if errors.Is(err, sql.ErrNoRows) {
		return value, ErrNotFound
	}
	return value, err
}
