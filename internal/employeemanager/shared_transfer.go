package employeemanager

import (
	"context"
	"errors"
	"path/filepath"

	"workagent3/internal/userhost"
)

// SharedTransferManager executes cross-user shared-project ownership transfers
// (transfer, transfer_commit, transfer_rollback) under the Employee Manager's
// SYSTEM identity. The move crosses two accounts' protected owner roots and
// rewrites owner plus protected DACL, which a limited UserHost token cannot
// do (no SeRestore/SeSecurity/SeTakeOwnership privileges, no write access to
// the other account's tree). Portal therefore routes these actions here
// instead of to the owner Runtime; the recovery journal keeps its established
// location under the new owner's SID-private data root.
type SharedTransferManager struct{ base string }

func NewSharedTransferManager(dataRootBase string) (*SharedTransferManager, error) {
	if !filepath.IsAbs(dataRootBase) {
		return nil, errors.New("shared transfer manager requires an absolute employee data root")
	}
	return &SharedTransferManager{base: filepath.Clean(dataRootBase)}, nil
}

func (m *SharedTransferManager) Apply(ctx context.Context, projectID string, request userhost.SharedProjectRequest) error {
	switch request.Action {
	case "transfer", "transfer_commit", "transfer_rollback":
	default:
		return errors.New("shared transfer manager only handles ownership transfer actions")
	}
	manager, err := userhost.NewSharedProjectManager(filepath.Join(m.base, request.OwnerSID), request.OwnerSID)
	if err != nil {
		return err
	}
	return manager.Apply(ctx, projectID, request)
}
