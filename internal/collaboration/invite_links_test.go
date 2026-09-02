package collaboration

import (
	"errors"
	"testing"
	"time"
)

const inviteLinkToken = "invite_link_token_1234567890"

func createInviteLink(t *testing.T, store *Store, project Project, token string, maxUses int, lifetime time.Duration) InviteLink {
	t.Helper()
	link, err := store.CreateInviteLink(t.Context(), InviteLink{
		Token: token, ProjectID: project.ID, CreatorUserID: 1, MaxUses: maxUses,
		ExpiresAt: store.now().Add(lifetime),
	})
	if err != nil {
		t.Fatalf("create invite link: %v", err)
	}
	return link
}

func acceptInviteLink(t *testing.T, store *Store, token string, userID int64, sid string) Project {
	t.Helper()
	if _, err := store.BeginInviteLinkAcceptance(t.Context(), token, userID, sid); err != nil {
		t.Fatalf("begin invite link acceptance: %v", err)
	}
	project, err := store.CompleteInviteLinkAcceptance(t.Context(), token, userID)
	if err != nil {
		t.Fatalf("complete invite link acceptance: %v", err)
	}
	return project
}

func TestInviteLinkMultiUseLifecycle(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	link := createInviteLink(t, store, project, inviteLinkToken, 0, time.Hour)
	if link.Status != "active" || link.ProjectName != project.Name || link.MaxUses != 0 {
		t.Fatalf("link = %#v", link)
	}

	acceptInviteLink(t, store, inviteLinkToken, 2, memberSID)
	acceptInviteLink(t, store, inviteLinkToken, 3, "S-1-5-21-3000")

	link, err := store.InviteLink(t.Context(), inviteLinkToken)
	if err != nil || link.UseCount != 2 || link.Status != "active" {
		t.Fatalf("link after accepts = %#v, %v", link, err)
	}
	members, err := store.Members(t.Context(), project.ID, 1)
	if err != nil || len(members) != 3 {
		t.Fatalf("members = %#v, %v", members, err)
	}
}

func TestInviteLinkSingleUseExhausts(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	createInviteLink(t, store, project, inviteLinkToken, 1, time.Hour)

	acceptInviteLink(t, store, inviteLinkToken, 2, memberSID)

	link, err := store.InviteLink(t.Context(), inviteLinkToken)
	if err != nil || link.Status != "exhausted" || link.UseCount != 1 || link.ActedAt == nil {
		t.Fatalf("link = %#v, %v", link, err)
	}
	if _, err := store.BeginInviteLinkAcceptance(t.Context(), inviteLinkToken, 3, "S-1-5-21-3000"); !errors.Is(err, ErrInviteLinkExhausted) {
		t.Fatalf("second accept = %v", err)
	}
}

func TestInviteLinkExpiryRevocationAndMembershipGuards(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)

	expired := createInviteLink(t, store, project, "invite_link_expired_12345678", 0, time.Minute)
	store.now = func() time.Time { return time.Date(2026, 9, 1, 0, 2, 0, 0, time.UTC) }
	if _, err := store.BeginInviteLinkAcceptance(t.Context(), expired.Token, 2, memberSID); !errors.Is(err, ErrInviteExpired) {
		t.Fatalf("expired accept = %v", err)
	}
	if _, err := store.CreateInviteLink(t.Context(), InviteLink{Token: "invite_link_late_1234567890", ProjectID: project.ID, CreatorUserID: 1, ExpiresAt: store.now().Add(-time.Minute)}); !errors.Is(err, ErrInviteExpired) {
		t.Fatalf("create already-expired = %v", err)
	}

	link := createInviteLink(t, store, project, inviteLinkToken, 0, time.Hour)
	if err := store.RevokeInviteLink(t.Context(), link.Token, project.ID, 2); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-creator revoke = %v", err)
	}
	if err := store.RevokeInviteLink(t.Context(), link.Token, project.ID, 1); err != nil {
		t.Fatalf("revoke = %v", err)
	}
	if _, err := store.BeginInviteLinkAcceptance(t.Context(), inviteLinkToken, 2, memberSID); !errors.Is(err, ErrInviteLinkRevoked) {
		t.Fatalf("revoked accept = %v", err)
	}
	if _, err := store.BeginInviteLinkAcceptance(t.Context(), "invite_link_unknown_1234567", 2, memberSID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown token = %v", err)
	}

	usable := createInviteLink(t, store, project, "invite_link_reuse_1234567890", 0, time.Hour)
	acceptInviteLink(t, store, usable.Token, 2, memberSID)
	if _, err := store.BeginInviteLinkAcceptance(t.Context(), usable.Token, 2, memberSID); !errors.Is(err, ErrConflict) {
		t.Fatalf("repeat accept = %v", err)
	}
	if _, err := store.BeginInviteLinkAcceptance(t.Context(), usable.Token, 1, ownerSID); !errors.Is(err, ErrConflict) {
		t.Fatalf("owner accept = %v", err)
	}
}

func TestInviteLinkAbortReturnsTheSpentUse(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	createInviteLink(t, store, project, inviteLinkToken, 1, time.Hour)

	member, err := store.BeginInviteLinkAcceptance(t.Context(), inviteLinkToken, 2, memberSID)
	if err != nil || member.State != "pending_acl" {
		t.Fatalf("begin = %#v, %v", member, err)
	}
	link, err := store.InviteLink(t.Context(), inviteLinkToken)
	if err != nil || link.Status != "exhausted" {
		t.Fatalf("link after begin = %#v, %v", link, err)
	}
	if err := store.AbortInviteLinkAcceptance(t.Context(), inviteLinkToken, 2); err != nil {
		t.Fatalf("abort = %v", err)
	}
	link, err = store.InviteLink(t.Context(), inviteLinkToken)
	if err != nil || link.Status != "active" || link.UseCount != 0 || link.ActedAt != nil {
		t.Fatalf("link after abort = %#v, %v", link, err)
	}
	acceptInviteLink(t, store, inviteLinkToken, 2, memberSID)
	if _, err := store.ProjectForUser(t.Context(), project.ID, 2, true); err != nil {
		t.Fatalf("member project = %v", err)
	}
}

func TestInviteLinkCreationRequiresActiveOwnership(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	if _, err := store.CreateInviteLink(t.Context(), InviteLink{Token: inviteLinkToken, ProjectID: project.ID, CreatorUserID: 2, ExpiresAt: store.now().Add(time.Hour)}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-owner create = %v", err)
	}
	if _, err := store.CreateInviteLink(t.Context(), InviteLink{Token: "short", ProjectID: project.ID, CreatorUserID: 1, ExpiresAt: store.now().Add(time.Hour)}); err == nil {
		t.Fatal("weak token accepted")
	}
}
