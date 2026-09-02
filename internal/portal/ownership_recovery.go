package portal

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"workagent3/internal/audit"
)

// RecoverOwnershipTransfers completes the durable filesystem confirmation for
// ownership changes whose database transaction already selected the new owner.
// Both confirmation steps are idempotent, so a Portal restart may safely retry.
func (s *Server) RecoverOwnershipTransfers(ctx context.Context) error {
	if s.modules.Collaboration == nil || s.modules.SharedProjects == nil {
		return nil
	}
	transfers, err := s.modules.Collaboration.FinalizingOwnershipTransfers(ctx)
	if err != nil {
		return fmt.Errorf("list ownership transfers awaiting finalization: %w", err)
	}
	var recoveryErr error
	for _, transfer := range transfers {
		if err := s.modules.SharedProjects.FinalizeProjectOwnership(ctx, transfer.ProjectID, transfer.ToSID, true); err != nil {
			recoveryErr = errors.Join(recoveryErr, fmt.Errorf("confirm ownership transfer %s filesystem: %w", transfer.ID, err))
			continue
		}
		if err := s.modules.Collaboration.FinalizeOwnershipTransfer(ctx, transfer.ID); err != nil {
			recoveryErr = errors.Join(recoveryErr, fmt.Errorf("confirm ownership transfer %s database: %w", transfer.ID, err))
			continue
		}
		// The originating request already recorded a failure when it returned
		// ownership_transfer_recovery_pending; this is the deferred success.
		s.recordBusinessEvent(ctx, "portal-recovery", audit.ActionCollaborationOwnershipTransfer, transfer.ProjectID, nil, map[string]string{"transfer_id": transfer.ID, "recovered": "true"})
	}
	return recoveryErr
}

func (s *Server) RunOwnershipTransferRecovery(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	recover := func() {
		recoveryContext, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := s.RecoverOwnershipTransfers(recoveryContext); err != nil && ctx.Err() == nil {
			log.Printf("Portal ownership transfer recovery: %v", err)
		}
	}
	recover()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			recover()
		}
	}
}
