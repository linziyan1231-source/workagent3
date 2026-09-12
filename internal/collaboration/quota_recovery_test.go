package collaboration

import (
	"errors"
	"testing"
)

func TestQuotaRecoveryUsesFrozenRunIdentityAfterMembershipChanges(t *testing.T) {
	s := openTestStore(t)
	p := createActiveProject(t, s)
	ctx := t.Context()
	c, err := s.CreateConversation(ctx, Conversation{ID: "conversation_quota1", ProjectID: p.ID, Name: "Quota", AssistantID: "codex", AssistantBackend: "codex", ModelID: "model-1", ThinkingEffort: "medium"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.AddMessage(ctx, Message{ID: "message_quota_0001", Conversation: c.ID, Kind: "user", AuthorName: "Owner", Body: "Run"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.ReserveAIRun(ctx, "run_quota_00000001", m, 1)
	if err != nil {
		t.Fatal(err)
	}
	// Later account/membership and project changes are not billing authority
	// for an already admitted run.
	if _, err := s.db.Exec(`UPDATE shared_projects SET owner_sid=? WHERE id=?`, memberSID, p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE shared_members SET sid=? WHERE project_id=?`, memberSID, p.ID); err != nil {
		t.Fatal(err)
	}
	identity, err := s.QuotaRunIdentity(ctx, r.ID)
	if err != nil || identity.OwnerSID != r.OwnerSID || identity.PayerSID != r.PayerSID {
		t.Fatalf("identity changed: %+v %v", identity, err)
	}
	if _, err := s.db.Exec(`INSERT INTO shared_ai_run_payers(run_id,user_id,sid,share_denominator) VALUES(?,?,?,?)`, r.ID, 2, memberSID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := s.QuotaRunIdentity(ctx, r.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ambiguous historical payer chosen: %v", err)
	}
}
