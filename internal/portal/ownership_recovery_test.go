package portal

import (
	"path/filepath"
	"testing"
	"time"

	"workagent3/internal/collaboration"
)

func TestOwnershipTransferRecoveryRetriesAfterPortalRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collaboration.db")
	data, err := collaboration.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	project, err := data.CreateProject(t.Context(), collaboration.Project{ID: "project_recovery_12345", OwnerUserID: 1, OwnerSID: "S-1-5-21-1000", Name: "Recovery"})
	if err != nil {
		t.Fatal(err)
	}
	if err := data.SetProvisioningResult(t.Context(), project.ID, true); err != nil {
		t.Fatal(err)
	}
	invite, err := data.CreateInvite(t.Context(), collaboration.Invite{ID: "invite_recovery_12345", ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: "S-1-5-21-2000", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := data.BeginInviteAcceptance(t.Context(), invite.ID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := data.CompleteInviteAcceptance(t.Context(), invite.ID, 2); err != nil {
		t.Fatal(err)
	}
	transfer, err := data.BeginOwnershipTransfer(t.Context(), collaboration.OwnershipTransfer{ID: "transfer_recovery_123", ProjectID: project.ID, ToUserID: 2, ToSID: "S-1-5-21-2000"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := data.CompleteOwnershipTransfer(t.Context(), transfer.ID); err != nil {
		t.Fatal(err)
	}
	if err := data.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := collaboration.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	platform := &fakeSharedProjectPlatform{finalizeErr: errInjectedRecovery}
	server := &Server{modules: Modules{Collaboration: reopened, SharedProjects: platform}}
	if err := server.RecoverOwnershipTransfers(t.Context()); err == nil {
		t.Fatal("recovery unexpectedly succeeded while the owner Runtime failed")
	}
	if pending, err := reopened.FinalizingOwnershipTransfers(t.Context()); err != nil || len(pending) != 1 {
		t.Fatalf("failed recovery was not retained: %#v, %v", pending, err)
	}

	platform.finalizeErr = nil
	if err := server.RecoverOwnershipTransfers(t.Context()); err != nil {
		t.Fatal(err)
	}
	if pending, err := reopened.FinalizingOwnershipTransfers(t.Context()); err != nil || len(pending) != 0 {
		t.Fatalf("successful recovery was not finalized: %#v, %v", pending, err)
	}
	calls := len(platform.finalized)
	if err := server.RecoverOwnershipTransfers(t.Context()); err != nil || len(platform.finalized) != calls {
		t.Fatalf("completed transfer was retried: calls=%d now=%d err=%v", calls, len(platform.finalized), err)
	}
}

var errInjectedRecovery = &ownershipRecoveryTestError{}

type ownershipRecoveryTestError struct{}

func (*ownershipRecoveryTestError) Error() string { return "injected recovery failure" }
