package collaboration

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestAssistantMigrationPreservesLegacyCursorAndRecoversParallelRuns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collaboration.db")
	s := openStoreAt(t, path)
	p := createActiveProject(t, s)
	c, err := s.CreateConversation(t.Context(), Conversation{ID: "conversation_migrate1", ProjectID: p.ID, Name: "Legacy", AssistantID: "codex", AssistantBackend: "codex", ModelID: "model-1", ThinkingEffort: "medium"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.AddMessage(t.Context(), Message{ID: "message_migrate_001", Conversation: c.ID, Kind: "user", AuthorName: "Owner", Body: "Legacy context"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.ReserveAIRun(t.Context(), "run_migrate_000001", m, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.FinishAIRun(t.Context(), r, "reply_migrate_00001", "session-shared-"+c.ID, "Legacy answer", nil); err != nil {
		t.Fatal(err)
	}
	// Recreate the pre-membership schema, including its old active-run index.
	_, err = s.db.Exec(`DROP TABLE shared_assistant_sessions; DROP TABLE shared_assistant_members;
DROP INDEX shared_ai_one_assistant_active; DROP INDEX shared_ai_one_assistant_trigger;
ALTER TABLE shared_ai_runs DROP COLUMN assistant_id; ALTER TABLE shared_ai_runs DROP COLUMN assistant_name;
ALTER TABLE shared_messages DROP COLUMN author_assistant_id;
CREATE UNIQUE INDEX shared_ai_one_active ON shared_ai_runs(conversation_id) WHERE state='running';`)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s = openStoreAt(t, path)
	view, err := s.ConversationForUser(t.Context(), c.ID, 1, true)
	if err != nil || len(view.Assistants) != 1 {
		t.Fatalf("legacy membership: %#v %v", view, err)
	}
	if _, err = s.InviteAssistant(t.Context(), AssistantMember{ProjectID: p.ID, AssistantID: "kimi", Name: "Kimi", Backend: "kimi", ModelID: "kimi-model", ThinkingEffort: "low"}, 1); err != nil {
		t.Fatal(err)
	}
	next, err := s.AddMessage(t.Context(), Message{ID: "message_migrate_002", Conversation: c.ID, Kind: "user", AuthorName: "Owner", Body: "Both continue"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.ReserveAssistantRun(t.Context(), "run_migrate_000002", next, 1, "codex")
	if err != nil || a.SessionKey != "session-shared-"+c.ID || a.ContextFromSeq != m.Seq+1 || a.PreviousRuntimeSessionID != a.SessionKey {
		t.Fatalf("legacy continuation: %#v %v", a, err)
	}
	b, err := s.ReserveAssistantRun(t.Context(), "run_migrate_000003", next, 1, "kimi")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s = openStoreAt(t, path)
	view, err = s.ConversationForUser(t.Context(), c.ID, 1, true)
	if err != nil || view.State != "idle" || len(view.Assistants) != 2 {
		t.Fatalf("restart: %#v %v", view, err)
	}
	for _, member := range view.Assistants {
		if member.Active {
			t.Fatal("interrupted assistant left active")
		}
	}
	retry, err := s.AddMessage(t.Context(), Message{ID: "message_migrate_003", Conversation: c.ID, Kind: "user", AuthorName: "Owner", Body: "Retry both"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	for i, previous := range []AIRun{a, b} {
		id := []string{"run_migrate_000004", "run_migrate_000005"}[i]
		run, err := s.ReserveAssistantRun(t.Context(), id, retry, 1, previous.AssistantID)
		if err != nil || run.SessionKey != previous.SessionKey || run.ContextFromSeq != previous.ContextFromSeq {
			t.Fatalf("restart lost history: %#v %v", run, err)
		}
	}
}

func TestSharedAssistantsKeepIndependentSessionsAndGroupContext(t *testing.T) {
	s := openTestStore(t)
	project := createActiveProject(t, s)
	c, err := s.DefaultConversation(t.Context(), project.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	invite := func(id, engine string) AssistantMember {
		t.Helper()
		a, err := s.InviteAssistant(t.Context(), AssistantMember{ProjectID: project.ID, AssistantID: id, Name: id, Backend: engine, ModelID: "model-1", ThinkingEffort: "medium"}, 1)
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	a := invite("codex-one", "codex")
	b := invite("kimi-two", "kimi")
	message := func(id, body string) Message {
		t.Helper()
		m, err := s.AddMessage(t.Context(), Message{ID: id, Conversation: c.ID, AuthorName: "Owner", Kind: "user", Body: body}, 1)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	begin := func(id string, m Message, a string) AIRun {
		t.Helper()
		r, err := s.ReserveAssistantRun(t.Context(), id, m, 1, a)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	done := func(r AIRun, id, body string) Message {
		t.Helper()
		m, err := s.FinishAIRun(t.Context(), r, id, r.SessionKey, body, nil)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	first := message("message_first_123456", "@both discuss the plan")
	ar := begin("run_first_a_123456", first, a.AssistantID)
	br := begin("run_first_b_123456", first, b.AssistantID)
	if ar.SessionKey == br.SessionKey {
		t.Fatal("assistants shared a session")
	}
	if _, err := s.ReserveAssistantRun(t.Context(), "run_duplicate_12345", first, 1, a.AssistantID); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate/busy accepted: %v", err)
	}
	if _, err := s.UpdateAssistantSettings(t.Context(), project.ID, a.AssistantID, 1, "model-2", "high"); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed active assistant: %v", err)
	}
	arReply := done(ar, "reply_first_a_12345", "A's proposal")
	view, _ := s.ConversationForUser(t.Context(), c.ID, 1, true)
	if view.State != "running" {
		t.Fatal("B was still running")
	}
	done(br, "reply_first_b_12345", "B's critique")
	if arReply.AuthorAssistantID != a.AssistantID || arReply.AuthorName != a.Name {
		t.Fatal("missing assistant attribution")
	}
	nextB := message("message_next_b_12345", "@B revise your critique")
	br2 := begin("run_second_b_12345", nextB, b.AssistantID)
	done(br2, "reply_second_b_1234", "B's revised critique")
	nextA := message("message_next_a_12345", "@A consider the revisions")
	ar2 := begin("run_second_a_12345", nextA, a.AssistantID)
	if ar2.SessionKey != ar.SessionKey || ar2.PreviousRuntimeSessionID != ar.SessionKey || ar2.ContextFromSeq != first.Seq+1 {
		t.Fatalf("A's context cursor moved with B: %#v", ar2)
	}
	if br2.SessionKey != br.SessionKey {
		t.Fatal("B's session changed")
	}
	rows, err := s.SharedMessagesRange(t.Context(), c.ID, ar2.ContextFromSeq, ar2.ContextThroughSeq)
	if err != nil {
		t.Fatal(err)
	}
	bodies := []string{}
	for _, m := range rows {
		bodies = append(bodies, m.Body)
	}
	all := strings.Join(bodies, "|")
	for _, expected := range []string{"A's proposal", "B's critique", "@B revise", "B's revised critique", "@A consider"} {
		if !strings.Contains(all, expected) {
			t.Fatalf("missing group context %s: %s", expected, all)
		}
	}
	done(ar2, "reply_second_a_1234", "A continues")
	settings, err := s.UpdateAssistantSettings(t.Context(), project.ID, a.AssistantID, 1, "model-2", "high")
	if err != nil || settings.Backend != "codex" {
		t.Fatalf("settings: %#v %v", settings, err)
	}
	next := message("message_third_a_1234", "@A continue with new model")
	ar3 := begin("run_third_a_123456", next, a.AssistantID)
	if ar3.SessionKey != ar.SessionKey || ar3.ModelID != "model-2" || ar3.ThinkingEffort != "high" {
		t.Fatalf("model update reset identity: %#v", ar3)
	}
	if err := s.RemoveAssistant(t.Context(), project.ID, a.AssistantID, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("removed running assistant: %v", err)
	}
	_, _, err = s.StopAssistantRun(t.Context(), c.ID, a.AssistantID, 1, "stop_third_a_12345")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.RemoveAssistant(t.Context(), project.ID, a.AssistantID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReserveAssistantRun(t.Context(), "run_removed_123456", next, 1, a.AssistantID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("removed assistant triggered: %v", err)
	}
	if _, err = s.InviteAssistant(t.Context(), AssistantMember{ProjectID: project.ID, AssistantID: a.AssistantID, Name: "Replacement", Backend: "kimi", ModelID: "model-1", ThinkingEffort: "low"}, 1); !errors.Is(err, ErrAssistantLocked) {
		t.Fatalf("rejoin changed engine: %v", err)
	}
	invite(a.AssistantID, a.Backend)
	last := message("message_rejoin_12345", "@A rejoined")
	rejoined := begin("run_rejoined_12345", last, a.AssistantID)
	if rejoined.SessionKey != ar.SessionKey {
		t.Fatal("rejoining discarded the session")
	}
}

func TestSharedLegacyIdentityCannotBeReplacedButSettingsCanChange(t *testing.T) {
	s := openTestStore(t)
	p := createActiveProject(t, s)
	c, err := s.CreateConversation(t.Context(), Conversation{ID: "conversation_legacy123", ProjectID: p.ID, Name: "Legacy", AssistantID: "codex", AssistantBackend: "codex", ModelID: "model-1", ThinkingEffort: "medium"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, config := range [][4]string{{"kimi", "kimi", "model-1", "medium"}, {"codex", "kimi", "model-1", "medium"}, {"", "", "", ""}} {
		if _, err = s.BindAssistant(t.Context(), c.ID, 1, config[0], config[1], config[2], config[3]); !errors.Is(err, ErrAssistantLocked) {
			t.Fatalf("identity replaced: %v", err)
		}
	}
	if _, err = s.BindAssistant(t.Context(), c.ID, 1, "codex", "codex", "model-2", "high"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.InviteAssistant(t.Context(), AssistantMember{ProjectID: p.ID, AssistantID: "codex", Name: "Codex", Backend: "codex", ModelID: "model-1", ThinkingEffort: "medium"}, 1); !errors.Is(err, ErrMemberExists) {
		t.Fatalf("duplicate membership: %v", err)
	}
}
