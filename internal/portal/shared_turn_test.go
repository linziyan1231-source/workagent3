package portal

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/notifications"
	"workagent3/internal/quota"
	"workagent3/internal/store"
)

type sharedTurnAuthorizerStub struct{}

func (sharedTurnAuthorizerStub) Authorized(context.Context, string, string) (bool, error) {
	return true, nil
}

func sharedTurnQuotaServer(t *testing.T, budgetLimit int64) (http.Handler, *quota.Store, *fakeSharedProjectPlatform, collaborationTestUser, collaborationTestUser) {
	t.Helper()
	users, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = users.Close() })
	collaborationData, err := collaboration.Open(filepath.Join(t.TempDir(), "collaboration.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = collaborationData.Close() })
	quotas, err := quota.Open(":memory:", sharedTurnAuthorizerStub{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = quotas.Close() })
	notices, err := notifications.Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = notices.Close() })
	hash, err := auth.HashPassword([]byte("test-password"))
	if err != nil {
		t.Fatal(err)
	}
	create := func(username, sid, session string) collaborationTestUser {
		user, err := users.CreateUser(t.Context(), username, sid, hash)
		if err != nil {
			t.Fatal(err)
		}
		if err := users.CreateSession(t.Context(), session, user.ID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		return collaborationTestUser{user: user, session: session}
	}
	alice := create("alice", "S-1-5-21-1000", "alice-quota-session")
	bob := create("bob", "S-1-5-21-2000", "bob-quota-session")
	if err := quotas.SetBudget(t.Context(), quota.Budget{SID: bob.user.SID, ModelID: "gpt-5", Period: quota.Daily, LimitUnits: budgetLimit}); err != nil {
		t.Fatal(err)
	}
	platform := &fakeSharedProjectPlatform{}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{
		ModelAccess: collaborationModelAccess{}, Collaboration: collaborationData,
		SharedProjects: platform, SharedFiles: platform, SharedTurns: platform,
		SharedRunQuota: quotas, Notifications: notices,
	})
	if err != nil {
		t.Fatal(err)
	}
	return server.Handler(), quotas, platform, alice, bob
}

func sharedTurnConversation(t *testing.T, handler http.Handler, alice, bob collaborationTestUser) string {
	t.Helper()
	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Quota"}`)
	var projectBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &projectBody) != nil {
		t.Fatalf("create project = %d %s", created.Code, created.Body.String())
	}
	invited := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects/"+projectBody.Project.ID+"/invites", `{"targetUsername":"bob","expiresInHours":24}`)
	var inviteBody struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	if invited.Code != http.StatusCreated || json.Unmarshal(invited.Body.Bytes(), &inviteBody) != nil {
		t.Fatalf("invite = %d %s", invited.Code, invited.Body.String())
	}
	if accepted := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-invites/"+inviteBody.Invite.ID+"/accept", `{}`); accepted.Code != http.StatusOK {
		t.Fatalf("accept = %d %s", accepted.Code, accepted.Body.String())
	}
	conversation := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-conversations", `{"project_id":"`+projectBody.Project.ID+`","name":"Review","assistant_id":"codex","assistant_backend":"codex","model_id":"gpt-5","thinking_effort":"medium"}`)
	var conversationBody struct {
		Conversation sharedConversationDTO `json:"conversation"`
	}
	if conversation.Code != http.StatusCreated || json.Unmarshal(conversation.Body.Bytes(), &conversationBody) != nil {
		t.Fatalf("create conversation = %d %s", conversation.Code, conversation.Body.String())
	}
	return conversationBody.Conversation.ID
}

func mentionAssistant(t *testing.T, handler http.Handler, session, conversationID, body string) bool {
	t.Helper()
	response := collaborationRequest(t, handler, session, http.MethodPost, "/api/portal/shared-messages", `{"conversation_id":"`+conversationID+`","body":"`+body+`","mentions":[{"kind":"assistant","id":"codex"}],"attachments":[]}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("mention message = %d %s", response.Code, response.Body.String())
	}
	var result struct {
		AIStarted bool `json:"ai_started"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.AIStarted
}

func TestSharedAIRunReservesQuotaAgainstTriggerer(t *testing.T) {
	handler, quotas, platform, alice, bob := sharedTurnQuotaServer(t, 100000)
	conversationID := sharedTurnConversation(t, handler, alice, bob)

	if !mentionAssistant(t, handler, bob.session, conversationID, "Please answer") {
		t.Fatal("shared AI run did not start with sufficient triggerer quota")
	}
	deadline := time.Now().Add(time.Second)
	for platform.turnOwner == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if platform.turnRequest.PayerSID != bob.user.SID {
		t.Fatalf("payer snapshot = %q, want triggerer %q", platform.turnRequest.PayerSID, bob.user.SID)
	}
	usage, err := quotas.Usage(t.Context(), bob.user.SID, "gpt-5", time.Now())
	if err != nil || usage.ReservedUnits != estimatedSharedTurnUnits(platform.turnRequest.Context) {
		t.Fatalf("triggerer reservation = %#v, %v", usage, err)
	}
}

func TestSharedAIRunBlockedWhenTriggererQuotaExceeded(t *testing.T) {
	handler, quotas, platform, alice, bob := sharedTurnQuotaServer(t, 1)
	conversationID := sharedTurnConversation(t, handler, alice, bob)

	if mentionAssistant(t, handler, bob.session, conversationID, "Please answer") {
		t.Fatal("shared AI run started despite exhausted triggerer quota")
	}
	time.Sleep(20 * time.Millisecond)
	if platform.turnOwner != "" {
		t.Fatalf("runtime received a turn for a blocked run: %q", platform.turnOwner)
	}
	listed := collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/shared-messages?conversation_id="+conversationID, "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), "quota of the member who mentioned the assistant is exhausted") {
		t.Fatalf("conversation lacks the visible quota failure message = %d %s", listed.Code, listed.Body.String())
	}
	feed := collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/me/notifications", "")
	if feed.Code != http.StatusOK || !strings.Contains(feed.Body.String(), "Shared AI run not started") {
		t.Fatalf("triggerer was not notified = %d %s", feed.Code, feed.Body.String())
	}
	conversation := collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/shared-conversations?id="+conversationID, "")
	if conversation.Code != http.StatusOK || !strings.Contains(conversation.Body.String(), `"state":"idle"`) {
		t.Fatalf("blocked run did not release the conversation = %d %s", conversation.Code, conversation.Body.String())
	}
	usage, err := quotas.Usage(t.Context(), bob.user.SID, "gpt-5", time.Now())
	if err != nil || usage.ReservedUnits != 0 || usage.ConsumedUnits != 0 {
		t.Fatalf("blocked run left quota residue = %#v, %v", usage, err)
	}
}
