package collaboration

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestPersonalTaskJournalSurvivesEveryCommittedStep(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collaboration.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	project := createActiveProject(t, s)
	op := PersonalTaskOperation{ID: "ptask_durable_123456", UserID: 1, CreatorSID: ownerSID, ProjectID: project.ID, Name: "Task", Configuration: json.RawMessage(`{"engine":"kimi","title":"Task"}`)}
	op, err = s.BeginPersonalTask(t.Context(), op)
	if err != nil {
		t.Fatal(err)
	}
	reopen := func(state string) {
		t.Helper()
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
		s, err = Open(path)
		if err != nil {
			t.Fatal(err)
		}
		op, err = s.PersonalTaskOperation(t.Context(), op.ID, 1)
		if err != nil || op.State != state {
			t.Fatalf("reopen %s: %#v %v", state, op, err)
		}
	}
	reopen("creating")
	if err = s.RecordPersonalTaskSession(t.Context(), op, personalTaskSessionID); err != nil {
		t.Fatal(err)
	}
	reopen("linking")
	if err = s.CompletePersonalTaskCreation(t.Context(), op); err != nil {
		t.Fatal(err)
	}
	reopen("ready")
	if row, err := s.ConversationForUser(t.Context(), op.ID, 1, true); err != nil || row.RuntimeSessionID != personalTaskSessionID {
		t.Fatalf("pointer %#v %v", row, err)
	}
	changed := op
	changed.Configuration = json.RawMessage(`{"engine":"codex","title":"Task"}`)
	if _, err = s.BeginPersonalTask(t.Context(), changed); !errors.Is(err, ErrConflict) {
		t.Fatal("changed request reused operation", err)
	}
	op, err = s.BeginPersonalTaskDeletion(t.Context(), op.ID, 1, ownerSID)
	if err != nil {
		t.Fatal(err)
	}
	reopen("deleting")
	if err = s.CompletePersonalTaskDeletion(t.Context(), op); err != nil {
		t.Fatal(err)
	}
	reopen("deleted")
	if pending, err := s.PendingPersonalTasks(t.Context()); err != nil || len(pending) != 0 {
		t.Fatalf("pending %#v %v", pending, err)
	}
	if _, err = s.ConversationForUser(t.Context(), op.ID, 1, true); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if retry, err := s.BeginPersonalTask(t.Context(), op); err != nil || retry.State != "deleted" {
		t.Fatalf("retry resurrected %#v %v", retry, err)
	}
}
