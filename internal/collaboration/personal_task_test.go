package collaboration

import (
	"errors"
	"testing"
	"time"
)

const personalTaskSessionID = "session-12345678-1234-1234-1234-123456789012"

func createPersonalTask(t *testing.T, store *Store, projectID string, creator int64) Conversation {
	t.Helper()
	conversation, err := store.CreateConversation(t.Context(), Conversation{
		ID: "ptask_personal_12345", ProjectID: projectID, Name: "个人任务",
		Kind: "personal_task", CreatorUserID: creator, RuntimeSessionID: personalTaskSessionID,
	}, creator)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

func TestPersonalTaskVisibleOnlyToCreator(t *testing.T) {
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
	discussion, err := store.CreateConversation(t.Context(), Conversation{ID: "discussion_shared_1234", ProjectID: project.ID, Name: "Shared"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if discussion.Kind != "discussion" || discussion.CreatorUserID != 0 || discussion.RuntimeSessionID != "" {
		t.Fatalf("discussion defaults changed: %#v", discussion)
	}
	task := createPersonalTask(t, store, project.ID, 1)
	if task.Kind != "personal_task" || task.CreatorUserID != 1 || task.RuntimeSessionID != personalTaskSessionID || task.AssistantID != "" || len(task.Assistants) != 0 {
		t.Fatalf("personal task = %#v", task)
	}
	values, err := store.ListConversations(t.Context(), 1, false)
	if err != nil || len(values) != 2 {
		t.Fatalf("creator conversations = %#v, %v", values, err)
	}
	for _, hidden := range []bool{false, true} {
		memberValues, err := store.ListConversations(t.Context(), 2, hidden)
		if err != nil || len(memberValues) != 1 || memberValues[0].ID != discussion.ID {
			t.Fatalf("member conversations (hidden=%v) = %#v, %v", hidden, memberValues, err)
		}
	}
	view, err := store.ConversationForUser(t.Context(), task.ID, 1, true)
	if err != nil || view.Kind != "personal_task" || view.RuntimeSessionID != personalTaskSessionID {
		t.Fatalf("creator view = %#v, %v", view, err)
	}
	if _, err := store.ConversationForUser(t.Context(), task.ID, 2, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("member view = %v", err)
	}
	if _, err := store.AddMessage(t.Context(), Message{ID: "message_ptask_member", Conversation: task.ID, AuthorName: "Member", Kind: "user", Body: "Nope"}, 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("member posted to personal task = %v", err)
	}
	if _, err := store.AddMessage(t.Context(), Message{ID: "message_ptask_123456", Conversation: task.ID, AuthorName: "Owner", Kind: "user", Body: "Private note"}, 1); err != nil {
		t.Fatal(err)
	}
	replay, err := store.ListMessagesForUserAfter(t.Context(), 2, 0, 100)
	if err != nil || len(replay) != 0 {
		t.Fatalf("member replay leaked personal task message = %#v, %v", replay, err)
	}
}

func TestPersonalTaskValidation(t *testing.T) {
	store := openTestStore(t)
	project := createActiveProject(t, store)
	valid := Conversation{ID: "ptask_validate_1234", ProjectID: project.ID, Name: "Task", Kind: "personal_task", CreatorUserID: 1, RuntimeSessionID: personalTaskSessionID}
	broken := []Conversation{
		{ID: valid.ID, ProjectID: project.ID, Name: "Task", Kind: "personal_task", CreatorUserID: 1},
		{ID: valid.ID, ProjectID: project.ID, Name: "Task", Kind: "personal_task", CreatorUserID: 1, RuntimeSessionID: "short"},
		{ID: valid.ID, ProjectID: project.ID, Name: "Task", Kind: "personal_task", RuntimeSessionID: personalTaskSessionID},
		{ID: valid.ID, ProjectID: project.ID, Name: "Task", Kind: "personal_task", CreatorUserID: 1, RuntimeSessionID: personalTaskSessionID, AssistantID: "codex", AssistantBackend: "codex", ModelID: "gpt-5", ThinkingEffort: "medium"},
		{ID: valid.ID, ProjectID: project.ID, Name: "Task", Kind: "junk"},
	}
	for i, conversation := range broken {
		if _, err := store.CreateConversation(t.Context(), conversation, 1); err == nil {
			t.Fatalf("case %d accepted: %#v", i, conversation)
		}
	}
	created, err := store.CreateConversation(t.Context(), valid, 1)
	if err != nil || created.Kind != "personal_task" {
		t.Fatalf("valid personal task = %#v, %v", created, err)
	}
}

func TestPersonalTaskDeleteOnlyByCreator(t *testing.T) {
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
	// A plain member owns this personal task; the project owner cannot see it.
	task := createPersonalTask(t, store, project.ID, 2)
	if err := store.DeleteConversation(t.Context(), task.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owner delete of member personal task = %v", err)
	}
	if err := store.DeleteConversation(t.Context(), task.ID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConversationForUser(t.Context(), task.ID, 2, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted personal task lookup = %v", err)
	}
}

func TestPersonalTaskMetadataOnlyByCreator(t *testing.T) {
	for _, creator := range []int64{1, 2} {
		label := "project owner creator"
		if creator == 2 {
			label = "project member creator"
		}
		t.Run(label, func(t *testing.T) {
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
			task := createPersonalTask(t, store, project.ID, creator)
			name, pinned := "  我的新任务名称  ", true
			updated, err := store.UpdateConversationMetadata(t.Context(), task.ID, creator, &name, &pinned, nil)
			if err != nil || updated.Name != "我的新任务名称" || !updated.Pinned || updated.PinnedAt == nil {
				t.Fatalf("creator rename and pin = %#v, %v", updated, err)
			}

			other := int64(3) - creator
			for _, action := range []string{"rename", "pin", "hide"} {
				var nextName *string
				var nextPinned, nextHidden *bool
				foreignName, enabled := "他人改名", true
				switch action {
				case "rename":
					nextName = &foreignName
				case "pin":
					nextPinned = &enabled
				case "hide":
					nextHidden = &enabled
				}
				if _, err := store.UpdateConversationMetadata(t.Context(), task.ID, other, nextName, nextPinned, nextHidden); !errors.Is(err, ErrNotFound) {
					t.Fatalf("noncreator %s = %v", action, err)
				}
			}
			view, err := store.ConversationForUser(t.Context(), task.ID, creator, true)
			if err != nil || view.Name != updated.Name || !view.Pinned || view.Hidden {
				t.Fatalf("rejected updates changed the creator's task = %#v, %v", view, err)
			}
			var foreignState int
			if err := store.db.QueryRowContext(t.Context(), `SELECT (SELECT COUNT(*) FROM shared_conversation_user_state WHERE conversation_id=? AND user_id=?) + (SELECT COUNT(*) FROM shared_conversation_visibility WHERE conversation_id=? AND user_id=?)`, task.ID, other, task.ID, other).Scan(&foreignState); err != nil || foreignState != 0 {
				t.Fatalf("rejected updates wrote noncreator state = %d, %v", foreignState, err)
			}
			pinned = false
			updated, err = store.UpdateConversationMetadata(t.Context(), task.ID, creator, nil, &pinned, nil)
			if err != nil || updated.Pinned || updated.PinnedAt != nil {
				t.Fatalf("creator unpin = %#v, %v", updated, err)
			}
		})
	}
}
