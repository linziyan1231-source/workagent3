package collaboration

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

const (
	projectID  = "project_1234567890"
	inviteID   = "invite_12345678901"
	transferID = "transfer_123456789"
	ownerSID   = "S-1-5-21-1000"
	memberSID  = "S-1-5-21-2000"
)

func TestMigrationAddsOwnershipTransferFinalizationMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collaboration.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE shared_ownership_transfers (
id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_user_id INTEGER NOT NULL,
to_user_id INTEGER NOT NULL, to_sid TEXT NOT NULL,
state TEXT NOT NULL CHECK (state IN ('pending','committed','aborted')),
created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	rows, err := store.db.Query(`PRAGMA table_info(shared_ownership_transfers)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatal(err)
		}
		found = found || name == "finalized_at"
	}
	if !found {
		t.Fatal("finalized_at column was not added")
	}
}

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
	if _, err := store.BeginInviteAcceptance(t.Context(), invite.ID, 3); !errors.Is(err, ErrForbidden) {
		t.Fatalf("another user accepted invite: %v", err)
	}
	pending, err := store.BeginInviteAcceptance(t.Context(), invite.ID, 2)
	if err != nil || pending.State != "pending_acl" {
		t.Fatalf("pending member = %#v, %v", pending, err)
	}
	if _, err := store.ProjectForUser(t.Context(), project.ID, 2, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending ACL member gained access: %v", err)
	}
	joined, err := store.CompleteInviteAcceptance(t.Context(), invite.ID, 2)
	if err != nil || joined.CurrentRole != "member" {
		t.Fatalf("joined project = %#v, %v", joined, err)
	}
	members, err := store.Members(t.Context(), project.ID, 2)
	if err != nil || len(members) != 2 || members[0].Role != "owner" || members[1].Role != "member" {
		t.Fatalf("members = %#v, %v", members, err)
	}
	removing, err := store.BeginMemberRemoval(t.Context(), project.ID, 1, 2)
	if err != nil || removing.State != "removal_pending" {
		t.Fatalf("removing member = %#v, %v", removing, err)
	}
	if _, err := store.ProjectForUser(t.Context(), project.ID, 2, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removal-pending member retained access: %v", err)
	}
	if err := store.AbortMemberRemoval(t.Context(), project.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ProjectForUser(t.Context(), project.ID, 2, true); err != nil {
		t.Fatalf("aborted removal did not restore access: %v", err)
	}
	if _, err := store.BeginMemberRemoval(t.Context(), project.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteMemberRemoval(t.Context(), project.ID, 1, 2); err != nil {
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
	if _, err := store.BeginInviteAcceptance(t.Context(), invite.ID, 2); !errors.Is(err, ErrInviteExpired) {
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
	acceptInvite(t, store, third.ID, 2)
	if _, err := store.BeginMemberRemoval(t.Context(), project.ID, 1, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("owner left project: %v", err)
	}
	if _, err := store.BeginMemberRemoval(t.Context(), project.ID, 2, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteMemberRemoval(t.Context(), project.ID, 2, 2); err != nil {
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
	acceptInvite(t, store, invite.ID, 2)
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
	finalizing, err := reopened.FinalizingOwnershipTransfers(t.Context())
	if err != nil || len(finalizing) != 1 || finalizing[0].ID != transfer.ID {
		t.Fatalf("finalizing transfers = %#v, %v", finalizing, err)
	}
	if _, err := reopened.BeginOwnershipTransfer(t.Context(), OwnershipTransfer{ID: "transfer_followup_1234", ProjectID: project.ID, ToUserID: 1, ToSID: ownerSID}, 2); !errors.Is(err, ErrTransferPending) {
		t.Fatalf("overlapping ownership transfer was accepted: %v", err)
	}
	if err := reopened.FinalizeOwnershipTransfer(t.Context(), transfer.ID); err != nil {
		t.Fatal(err)
	}
	if err := reopened.FinalizeOwnershipTransfer(t.Context(), transfer.ID); err != nil {
		t.Fatalf("replayed database finalization was not idempotent: %v", err)
	}
	if finalizing, err := reopened.FinalizingOwnershipTransfers(t.Context()); err != nil || len(finalizing) != 0 {
		t.Fatalf("finalized transfer remained recoverable: %#v, %v", finalizing, err)
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

func TestInviteAcceptanceCanRollbackACLFailure(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	invite, err := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BeginInviteAcceptance(t.Context(), invite.ID, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.AbortInviteAcceptance(t.Context(), invite.ID, 2); err != nil {
		t.Fatal(err)
	}
	stored, err := store.Invite(t.Context(), invite.ID)
	if err != nil || stored.Status != "pending" {
		t.Fatalf("rolled-back invite = %#v, %v", stored, err)
	}
	if _, err := store.ProjectForUser(t.Context(), project.ID, 2, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rolled-back acceptance retained access: %v", err)
	}
	acceptInvite(t, store, invite.ID, 2)
}

func TestACLStateTracksPendingFilesystemProjection(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	invite, err := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BeginInviteAcceptance(t.Context(), invite.ID, 2); err != nil {
		t.Fatal(err)
	}
	owner, members, err := store.ACLState(t.Context(), project.ID)
	if err != nil || owner != ownerSID || len(members) != 1 || members[0] != memberSID {
		t.Fatalf("pending ACL state = %q %#v, %v", owner, members, err)
	}
	rootMembers, err := store.OwnerRootACLState(t.Context(), ownerSID)
	if err != nil || len(rootMembers) != 1 || rootMembers[0] != memberSID {
		t.Fatalf("pending owner-root ACL state = %#v, %v", rootMembers, err)
	}
	if _, err := store.CompleteInviteAcceptance(t.Context(), invite.ID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BeginMemberRemoval(t.Context(), project.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	owner, members, err = store.ACLState(t.Context(), project.ID)
	if err != nil || owner != ownerSID || len(members) != 0 {
		t.Fatalf("removal-pending ACL state = %q %#v, %v", owner, members, err)
	}
	rootMembers, err = store.OwnerRootACLState(t.Context(), ownerSID)
	if err != nil || len(rootMembers) != 0 {
		t.Fatalf("removal-pending owner-root ACL state = %#v, %v", rootMembers, err)
	}
	if err := store.AbortMemberRemoval(t.Context(), project.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	_, members, err = store.ACLState(t.Context(), project.ID)
	if err != nil || len(members) != 1 || members[0] != memberSID {
		t.Fatalf("restored ACL state = %#v, %v", members, err)
	}
}

func TestSharedConversationMessagesReplayOnlyForCurrentMembers(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	invite, err := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	acceptInvite(t, store, invite.ID, 2)
	conversation, err := store.CreateConversation(t.Context(), Conversation{
		ID: "conversation_123456789", ProjectID: project.ID, Name: "Review",
		AssistantID: "codex", AssistantBackend: "codex", ModelID: "gpt-5", ThinkingEffort: "medium",
	}, 1)
	if err != nil || conversation.Role != "owner" || conversation.State != "idle" {
		t.Fatalf("conversation = %#v, %v", conversation, err)
	}
	message, err := store.AddMessage(t.Context(), Message{
		ID: "message_123456789012", Conversation: conversation.ID, AuthorName: "Owner", Kind: "user", Body: "Please review",
		Mentions: []Mention{{Kind: "assistant", ID: "codex"}}, Attachments: []string{"spec.md"},
	}, 1)
	if err != nil || message.Seq != 1 || message.AuthorUserID == nil || *message.AuthorUserID != 1 {
		t.Fatalf("message = %#v, %v", message, err)
	}
	replay, err := store.ListMessagesForUserAfter(t.Context(), 2, 0, 100)
	if err != nil || len(replay) != 1 || replay[0].Body != "Please review" || len(replay[0].Mentions) != 1 {
		t.Fatalf("member replay = %#v, %v", replay, err)
	}
	if _, err := store.BeginMemberRemoval(t.Context(), project.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	replay, err = store.ListMessagesForUserAfter(t.Context(), 2, 0, 100)
	if err != nil || len(replay) != 0 {
		t.Fatalf("removed member replay = %#v, %v", replay, err)
	}
	if _, err := store.ListMessages(t.Context(), conversation.ID, 3, 0, 100); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider message access = %v", err)
	}
}

func TestSharedConversationVisibilityIsPerMember(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	invite, _ := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	acceptInvite(t, store, invite.ID, 2)
	conversation, err := store.CreateConversation(t.Context(), Conversation{
		ID: "conversation_abcdefgh", ProjectID: project.ID, Name: "Hidden",
		AssistantID: "kimi", AssistantBackend: "kimi", ModelID: "kimi-code", ThinkingEffort: "high",
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetConversationHidden(t.Context(), conversation.ID, 2, true); err != nil {
		t.Fatal(err)
	}
	if values, err := store.ListConversations(t.Context(), 2, false); err != nil || len(values) != 0 {
		t.Fatalf("member visible conversations = %#v, %v", values, err)
	}
	if values, err := store.ListConversations(t.Context(), 1, false); err != nil || len(values) != 1 {
		t.Fatalf("owner visible conversations = %#v, %v", values, err)
	}
	if values, err := store.ListConversations(t.Context(), 2, true); err != nil || len(values) != 1 || !values[0].Hidden {
		t.Fatalf("member hidden conversations = %#v, %v", values, err)
	}
	name, pinned := "Renamed", true
	if _, err := store.UpdateConversationMetadata(t.Context(), conversation.ID, 2, &name, nil, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member renamed conversation = %v", err)
	}
	memberView, err := store.UpdateConversationMetadata(t.Context(), conversation.ID, 2, nil, &pinned, nil)
	if err != nil || memberView.Name != "Hidden" || !memberView.Pinned || memberView.PinnedAt == nil {
		t.Fatalf("member pin update = %#v, %v", memberView, err)
	}
	ownerView, err := store.ConversationForUser(t.Context(), conversation.ID, 1, true)
	if err != nil || ownerView.Name != "Hidden" || ownerView.Pinned || ownerView.PinnedAt != nil {
		t.Fatalf("owner metadata view = %#v, %v", ownerView, err)
	}
	updated, err := store.UpdateConversationRuntime(t.Context(), conversation.ID, 1, "kimi-next", "medium")
	if err != nil || updated.ModelID != "kimi-next" || updated.ThinkingEffort != "medium" {
		t.Fatalf("runtime update = %#v, %v", updated, err)
	}
	message, err := store.AddMessage(t.Context(), Message{ID: "message_running_1234", Conversation: conversation.ID, AuthorName: "Owner", Kind: "user", Body: "Run"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReserveAIRun(t.Context(), "run_running_1234567", message, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateConversationRuntime(t.Context(), conversation.ID, 1, "kimi-late", "low"); !errors.Is(err, ErrConflict) {
		t.Fatalf("running runtime update = %v", err)
	}
}

func TestOnlyProjectOwnerCanDeleteConversation(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	invite, _ := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	acceptInvite(t, store, invite.ID, 2)
	conversation, err := store.CreateConversation(t.Context(), Conversation{
		ID: "conversation_delete_123", ProjectID: project.ID, Name: "Delete me",
		AssistantID: "kimi", AssistantBackend: "kimi", ModelID: "kimi-code", ThinkingEffort: "high",
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteConversation(t.Context(), conversation.ID, 2); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member delete = %v", err)
	}
	if err := store.DeleteConversation(t.Context(), conversation.ID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConversationForUser(t.Context(), conversation.ID, 1, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted conversation lookup = %v", err)
	}
}

func TestSharedAIRunFreezesOwnerAndPayerAcrossOwnershipTransfer(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	invite, _ := store.CreateInvite(t.Context(), Invite{ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID, ExpiresAt: store.now().Add(time.Hour)})
	acceptInvite(t, store, invite.ID, 2)
	conversation, err := store.CreateConversation(t.Context(), Conversation{ID: "conversation_turn_123", ProjectID: project.ID, Name: "Shared AI", AssistantID: "codex", AssistantBackend: "codex", ModelID: "gpt-5", ThinkingEffort: "high"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	message, err := store.AddMessage(t.Context(), Message{ID: "message_turn_123456", Conversation: conversation.ID, AuthorName: "Member", Kind: "user", Body: "Please help", Mentions: []Mention{{Kind: "assistant", ID: "codex"}}}, 2)
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.ReserveAIRun(t.Context(), "run_1234567890123456", message, 2)
	if err != nil || run.OwnerUserID != 1 || run.OwnerSID != ownerSID || run.PayerUserID != 2 || run.PayerSID != memberSID {
		t.Fatalf("frozen run = %#v, %v", run, err)
	}
	transfer, err := store.BeginOwnershipTransfer(t.Context(), OwnershipTransfer{ID: "transfer_turn_12345", ProjectID: project.ID, FromUserID: 1, ToUserID: 2, ToSID: memberSID}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteOwnershipTransfer(t.Context(), transfer.ID); err != nil {
		t.Fatal(err)
	}
	result, err := store.FinishAIRun(t.Context(), run, "message_ai_12345678", "session-shared-conversation_turn_123", "Completed", nil)
	if err != nil || result.Kind != "assistant" || result.Body != "Completed" {
		t.Fatalf("AI result = %#v, %v", result, err)
	}
	nextMessage, err := store.AddMessage(t.Context(), Message{ID: "message_turn_234567", Conversation: conversation.ID, AuthorName: "Former owner", Kind: "user", Body: "Continue", Mentions: []Mention{{Kind: "assistant", ID: "codex"}}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	next, err := store.ReserveAIRun(t.Context(), "run_2345678901234567", nextMessage, 1)
	if err != nil || next.OwnerUserID != 2 || next.OwnerSID != memberSID || next.PreviousRuntimeSessionID == "" {
		t.Fatalf("next frozen run = %#v, %v", next, err)
	}
	stopped, stopMessage, err := store.StopAIRun(t.Context(), conversation.ID, 1, "message_stop_123456")
	if err != nil || stopped.ID != next.ID || stopMessage.Kind != "system" {
		t.Fatalf("stopped run = %#v, %#v, %v", stopped, stopMessage, err)
	}
}

func TestSharedAIRunRecoveryFailsInterruptedRunClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collaboration.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) }
	project := createActiveProject(t, store)
	conversation, err := store.CreateConversation(t.Context(), Conversation{ID: "conversation_recover", ProjectID: project.ID, Name: "Recovery", AssistantID: "codex", AssistantBackend: "codex", ModelID: "gpt-5", ThinkingEffort: "medium"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	message, err := store.AddMessage(t.Context(), Message{ID: "message_recover_123", Conversation: conversation.ID, AuthorName: "Owner", Kind: "user", Body: "Recover me", Mentions: []Mention{{Kind: "assistant", ID: "codex"}}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReserveAIRun(t.Context(), "run_recover_123456", message, 1); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	view, err := reopened.ConversationForUser(t.Context(), conversation.ID, 1, true)
	if err != nil || view.State != "idle" {
		t.Fatalf("recovered conversation = %#v, %v", view, err)
	}
	messages, err := reopened.ListMessages(t.Context(), conversation.ID, 1, 0, 100)
	if err != nil || len(messages) != 2 || messages[1].Kind != "system" || !strings.Contains(messages[1].Body, "Portal restart") {
		t.Fatalf("recovery messages = %#v, %v", messages, err)
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

func acceptInvite(t *testing.T, store *Store, id string, userID int64) Project {
	t.Helper()
	if _, err := store.BeginInviteAcceptance(t.Context(), id, userID); err != nil {
		t.Fatal(err)
	}
	project, err := store.CompleteInviteAcceptance(t.Context(), id, userID)
	if err != nil {
		t.Fatal(err)
	}
	return project
}

func TestSharedAIRunPayerSurvivesTriggererRemoval(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	invite, err := store.CreateInvite(t.Context(), Invite{
		ID: inviteID, ProjectID: project.ID, InviterUserID: 1, TargetUserID: 2, TargetSID: memberSID,
		ExpiresAt: store.now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	acceptInvite(t, store, invite.ID, 2)
	conversation, err := store.CreateConversation(t.Context(), Conversation{ID: "conversation_payer_1", ProjectID: project.ID, Name: "Shared AI", AssistantID: "codex", AssistantBackend: "codex", ModelID: "gpt-5", ThinkingEffort: "medium"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	message, err := store.AddMessage(t.Context(), Message{ID: "message_payer_12345", Conversation: conversation.ID, AuthorName: "Member", Kind: "user", Body: "Please help", Mentions: []Mention{{Kind: "assistant", ID: "codex"}}}, 2)
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.ReserveAIRun(t.Context(), "run_payer_12345678", message, 2)
	if err != nil || run.PayerSID != memberSID {
		t.Fatalf("reserved run = %#v, %v", run, err)
	}
	// The owner removes the triggerer mid-run; the frozen payer must not move.
	if _, err := store.BeginMemberRemoval(t.Context(), project.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteMemberRemoval(t.Context(), project.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	stopped, _, err := store.StopAIRun(t.Context(), conversation.ID, 1, "message_stop_payer1")
	if err != nil || stopped.PayerUserID != 2 || stopped.PayerSID != memberSID {
		t.Fatalf("payer moved after member removal = %#v, %v", stopped, err)
	}
}

func TestSharedAIRunFailureExplainsQuotaDenial(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	conversation, err := store.CreateConversation(t.Context(), Conversation{ID: "conversation_quota_1", ProjectID: project.ID, Name: "Shared AI", AssistantID: "codex", AssistantBackend: "codex", ModelID: "gpt-5", ThinkingEffort: "medium"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	message, err := store.AddMessage(t.Context(), Message{ID: "message_quota_12345", Conversation: conversation.ID, AuthorName: "Owner", Kind: "user", Body: "Please help", Mentions: []Mention{{Kind: "assistant", ID: "codex"}}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.ReserveAIRun(t.Context(), "run_quota_12345678", message, 1)
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.FinishAIRun(t.Context(), run, "message_ai_quota_1", "", "", contracts.ErrQuotaExceeded)
	if err != nil || result.Kind != "system" || !strings.Contains(result.Body, "quota") {
		t.Fatalf("quota denial message = %#v, %v", result, err)
	}
	view, err := store.ConversationForUser(t.Context(), conversation.ID, 1, true)
	if err != nil || view.State != "idle" {
		t.Fatalf("denied run did not release the conversation = %#v, %v", view, err)
	}
}
