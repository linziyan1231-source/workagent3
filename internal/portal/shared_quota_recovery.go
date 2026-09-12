package portal

import (
	"context"
	"errors"
	"log"
	"time"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
)

// RunSharedQuotaRecovery resumes incomplete admission/settlement through the
// two data owners' public operations. It never opens either owner's database.
func (s *Server) RunSharedQuotaRecovery(ctx context.Context, interval time.Duration) {
	if s.modules.SharedRunQuota == nil || s.modules.Collaboration == nil {
		return
	}
	check := func() {
		if err := s.reconcileSharedQuota(ctx); err != nil && ctx.Err() == nil {
			log.Printf("Shared quota recovery: %v", err)
		}
	}
	check()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

func (s *Server) reconcileSharedQuota(ctx context.Context) error {
	quota := s.modules.SharedRunQuota
	pending, err := quota.PendingSharedRuns(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, run := range pending {
		identity, err := s.modules.Collaboration.QuotaRunIdentity(ctx, run.RunID)
		if errors.Is(err, collaboration.ErrNotFound) {
			continue
		} // unrelated legacy personal reservation
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if run.Legacy {
			if err := quota.RecoverSharedRunAuthorization(ctx, identity); err != nil {
				failures = append(failures, err)
				continue
			}
		}
		if identity.State != "running" {
			// Accepted executions are retained until Runtime completion arrives.
			// Cancellation is safe only before the runtime's atomic acceptance.
			if err := quota.ReleaseSharedRun(ctx, identity.PayerSID, identity.RunID); err != nil && !errors.Is(err, contracts.ErrQuotaRunAccepted) {
				failures = append(failures, err)
			}
		}
	}
	if err := quota.ReconcileSettlements(ctx); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}
