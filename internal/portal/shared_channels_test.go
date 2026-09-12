package portal

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"workagent3/internal/collaboration"
)

func TestSharedChannelAuthenticationFeedAndReadOnly(t *testing.T) {
	var server *Server
	_, db, _, alice, bob := collaborationTestServer(t, func(s *Server) { server = s })
	for _, u := range []collaborationTestUser{alice, bob} {
		if err := server.store.AuthorizeRuntime(t.Context(), u.user.SID, u.user.Username+"-credential"); err != nil {
			t.Fatal(err)
		}
	}
	p, err := db.CreateProject(t.Context(), collaboration.Project{ID: "channel_project_001", OwnerUserID: alice.user.ID, OwnerSID: alice.user.SID, Name: "Project"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetProvisioningResult(t.Context(), p.ID, true); err != nil {
		t.Fatal(err)
	}
	c, err := db.CreateConversation(t.Context(), collaboration.Conversation{ID: "channel_conversation1", ProjectID: p.ID, Name: "Discussion", AssistantID: "codex", AssistantBackend: "codex", ModelID: "gpt-test", ThinkingEffort: "low"}, alice.user.ID)
	if err != nil {
		t.Fatal(err)
	}
	call := func(action, sid, token, remote string, extra map[string]any) *httptest.ResponseRecorder {
		body := map[string]any{"action": action, "sid": sid, "conversationId": c.ID}
		for k, v := range extra {
			body[k] = v
		}
		encoded, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "http://localhost/internal/runtime/collaboration", bytes.NewReader(encoded))
		req.RemoteAddr = remote
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		server.SharedChannelHandler().ServeHTTP(out, req)
		return out
	}
	own := func(action string, extra map[string]any) *httptest.ResponseRecorder {
		return call(action, alice.user.SID, "alice-credential", "127.0.0.1:1234", extra)
	}
	if got := call("access", alice.user.SID, "alice-credential", "203.0.113.1:9", nil); got.Code != 403 {
		t.Fatal(got.Code)
	}
	if got := call("access", alice.user.SID, "bob-credential", "127.0.0.1:9", nil); got.Code != 401 {
		t.Fatal(got.Code)
	}
	if got := call("history", bob.user.SID, "bob-credential", "127.0.0.1:9", map[string]any{"limit": 2}); got.Code != 404 && got.Code != 403 {
		t.Fatal(got.Code)
	}
	for _, action := range []string{"stop", "steer"} {
		if got := own(action, nil); got.Code != 400 {
			t.Fatalf("idle %d %s", got.Code, got.Body)
		}
	}
	m, err := db.AddMessage(t.Context(), collaboration.Message{ID: "channel_message_001", Conversation: c.ID, Kind: "user", AuthorName: "Alice", Body: "task"}, alice.user.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err := db.ReserveAIRun(t.Context(), "channel_ai_run_001", m, alice.user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.FinishAIRun(t.Context(), run, "channel_answer_001", "session-shared-test", "Done", nil); err != nil {
		t.Fatal(err)
	}
	feed := own("feed", map[string]any{"after": 0})
	var page struct {
		Messages []sharedMessageDTO `json:"messages"`
	}
	json.Unmarshal(feed.Body.Bytes(), &page)
	if feed.Code != 200 || len(page.Messages) != 1 || page.Messages[0].Kind != "assistant" {
		t.Fatalf("feed %d %s", feed.Code, feed.Body)
	}
}
