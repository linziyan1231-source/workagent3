package collaboration

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

const (
	projectID  = "project_1234567890"
	inviteID   = "invite_12345678901"
	transferID = "transfer_123456789"
	ownerSID   = "S-1-5-21-1000"
	memberSID  = "S-1-5-21-2000"
)

func TestInvitationMembershipAndImmediateRemoval(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)

	invite, err := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil || invite.Status != "pending" {
		t.Fatalf("invite = %#v, %v", invite, err)
	}
	if _, err := store.AcceptInvite(t.Context(), invite.ID, 3); !errors.Is(err, ErrForbidden) {
		t.Fatalf("another user accepted invite: %v", err)
	}
	joined, err := store.AcceptInvite(t.Context(), invite.ID, 2)
	if err != nil || joined.CurrentRole != "member" {
		t.Fatalf("joined project = %#v, %v", joined, err)
	}
	members, err := store.Members(t.Context(), project.ID, 2)
	if err != nil || len(members) != 2 || members[0].Role != "owner" || members[1].Role != "member" {
		t.Fatalf("members = %#v, %v", members, err)
	}
	if err := store.RemoveMember(t.Context(), project.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ProjectForUser(t.Context(), project.ID, 2, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member retained access: %v", err)
	}
	if _, err := store.ProjectForUser(t.Context(), project.ID, 3, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider gained access: %v", err)
	}
}

func TestInviteExpiryDoesNotCreateMembership(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	invite, err := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Date(2026, 9, 1, 0, 2, 0, 0, time.UTC) }
	if _, err := store.AcceptInvite(t.Context(), invite.ID, 2); !errors.Is(err, ErrInviteExpired) {
		t.Fatalf("expired invite result: %v", err)
	}
	stored, err := store.Invite(t.Context(), invite.ID)
	if err != nil || stored.Status != "expired" {
		t.Fatalf("stored invite = %#v, %v", stored, err)
	}
	if _, err := store.ProjectForUser(t.Context(), project.ID, 2, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired invite created membership: %v", err)
	}
}

func TestInviteDeclineRevokeAndMemberLeave(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	first, err := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeclineInvite(t.Context(), first.ID, 2); err != nil {
		t.Fatal(err)
	}
	declined, _ := store.Invite(t.Context(), first.ID)
	if declined.Status != "declined" {
		t.Fatalf("declined invite = %#v", declined)
	}
	second, err := store.CreateInvite(t.Context(), Invite{
		ID: "invite_abcdefghijk", ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeInvite(t.Context(), second.ID, 2); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-owner revoked invite: %v", err)
	}
	if err := store.RevokeInvite(t.Context(), second.ID, 1); err != nil {
		t.Fatal(err)
	}
	third, err := store.CreateInvite(t.Context(), Invite{
		ID: "invite_lmnopqrstuv", ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcceptInvite(t.Context(), third.ID, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.LeaveProject(t.Context(), project.ID, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("owner left project: %v", err)
	}
	if err := store.LeaveProject(t.Context(), project.ID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ProjectForUser(t.Context(), project.ID, 2, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("departed member retained access: %v", err)
	}
}

func TestOwnershipTransferIsRecoverableAndAtomic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collaboration.db")
	store := openStoreAt(t, path)
	project := createActiveProject(t, store)
	invite, err := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcceptInvite(t.Context(), invite.ID, 2); err != nil {
		t.Fatal(err)
	}
	transfer, err := store.BeginOwnershipTransfer(t.Context(), OwnershipTransfer{
		ID: transferID, ProjectID: project.ID, ToUserID: 2, ToSID: memberSID,
	}, 1)
	if err != nil || transfer.State != "pending" {
		t.Fatalf("transfer = %#v, %v", transfer, err)
	}
	pendingProject, err := store.ProjectForUser(t.Context(), project.ID, 1, true)
	if err != nil || pendingProject.State != "transfer_pending" || pendingProject.OwnerUserID != 1 || pendingProject.PendingOwnerID == nil || *pendingProject.PendingOwnerID != 2 {
		t.Fatalf("pending project = %#v, %v", pendingProject, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	pending, err := reopened.PendingOwnershipTransfers(t.Context())
	if err != nil || len(pending) != 1 || pending[0].ID != transfer.ID {
		t.Fatalf("pending transfers = %#v, %v", pending, err)
	}
	completed, err := reopened.CompleteOwnershipTransfer(t.Context(), transfer.ID)
	if err != nil || completed.OwnerUserID != 2 || completed.OwnerSID != memberSID || completed.CurrentRole != "owner" || completed.State != "active" {
		t.Fatalf("completed project = %#v, %v", completed, err)
	}
	formerOwner, err := reopened.ProjectForUser(t.Context(), project.ID, 1, true)
	if err != nil || formerOwner.CurrentRole != "member" || formerOwner.OwnerUserID != 2 {
		t.Fatalf("former owner = %#v, %v", formerOwner, err)
	}
}

func TestProjectVisibilityAndOwnerAuthorization(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	if _, err := store.RenameProject(t.Context(), project.ID, 2, "Nope"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-owner renamed project: %v", err)
	}
	if err := store.SetHidden(t.Context(), project.ID, 1, true); err != nil {
		t.Fatal(err)
	}
	if projects, err := store.ListProjects(t.Context(), 1, false); err != nil || len(projects) != 0 {
		t.Fatalf("visible projects = %#v, %v", projects, err)
	}
	if projects, err := store.ListProjects(t.Context(), 1, true); err != nil || len(projects) != 1 || !projects[0].Hidden {
		t.Fatalf("all projects = %#v, %v", projects, err)
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	return openStoreAt(t, ":memory:")
}

func openStoreAt(t *testing.T, path string) *Store {
	t.Helper()
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func createActiveProject(t *testing.T, store *Store) Project {
	t.Helper()
	project, err := store.CreateProject(context.Background(), Project{
		ID: projectID, OwnerUserID: 1, OwnerSID: ownerSID, Name: "Shared Design",
	})
	if err != nil || project.State != "provisioning" || project.CurrentRole != "owner" {
		t.Fatalf("project = %#v, %v", project, err)
	}
	if err := store.SetProvisioningResult(context.Background(), project.ID, true); err != nil {
		t.Fatal(err)
	}
	project, err = store.ProjectForUser(context.Background(), project.ID, 1, true)
	if err != nil {
		t.Fatal(err)
	}
	return project
}
