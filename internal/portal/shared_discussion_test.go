package portal

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"workagent3/internal/collaboration"
)

func TestSharedProjectCreationAndMessageRetriesDoNotStartAssistant(t *testing.T) {
	handler, data, platform, alice, _ := collaborationTestServer(t)
	body := `{"name":"员工讨论","operation_id":"operation-create-123456"}`
	first := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", body)
	second := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", body)
	var result struct {
		Project      sharedProjectDTO      `json:"project"`
		Conversation sharedConversationDTO `json:"conversation"`
	}
	if first.Code != 201 || second.Code != 201 || json.Unmarshal(first.Body.Bytes(), &result) != nil {
		t.Fatalf("create: %s / %s", first.Body.String(), second.Body.String())
	}
	if len(platform.provisioned) != 1 || result.Conversation.AssistantID != "" || result.Conversation.ProjectID != result.Project.ID {
		t.Fatalf("incorrect default discussion: %#v", result)
	}
	message := `{"conversation_id":"` + result.Conversation.ID + `","body":"普通员工讨论","client_message_id":"operation-message-123456"}`
	saved := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-messages", message)
	retry := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-messages", message)
	if saved.Code != 201 || !strings.Contains(saved.Body.String(), `"ai_status":"not_requested"`) || retry.Code != 200 || !strings.Contains(retry.Body.String(), `"ai_status":"already_sent"`) {
		t.Fatalf("messages: %s / %s", saved.Body.String(), retry.Body.String())
	}
	rows, err := data.ListMessages(t.Context(), result.Conversation.ID, alice.user.ID, 0, 200)
	if err != nil || len(rows) != 1 || platform.turnOwner != "" {
		t.Fatalf("unexpected messages or execution: %d %v", len(rows), err)
	}
	conflict := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-messages", strings.Replace(message, "普通员工讨论", "修改内容", 1))
	if conflict.Code != 409 {
		t.Fatalf("changed retry: %d", conflict.Code)
	}
}

func TestSharedInvitationStatusesAndRevokedAccess(t *testing.T) {
	handler, _, _, alice, bob := collaborationTestServer(t)
	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"邀请项目"}`)
	var result struct {
		Project      sharedProjectDTO      `json:"project"`
		Conversation sharedConversationDTO `json:"conversation"`
	}
	if json.Unmarshal(created.Body.Bytes(), &result) != nil {
		t.Fatal(created.Body.String())
	}
	path := "/api/portal/shared-projects/" + result.Project.ID + "/invites"
	invited := collaborationRequest(t, handler, alice.session, http.MethodPost, path, `{"targetUsername":"bob"}`)
	var invite struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	if invited.Code != 201 || json.Unmarshal(invited.Body.Bytes(), &invite) != nil {
		t.Fatal(invited.Body.String())
	}
	duplicate := collaborationRequest(t, handler, alice.session, http.MethodPost, path, `{"targetUsername":"bob"}`)
	if duplicate.Code != 409 || !strings.Contains(duplicate.Body.String(), "shared_invite_already_pending") {
		t.Fatal(duplicate.Body.String())
	}
	accepted := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-invites/"+invite.Invite.ID+"/accept", `{}`)
	if accepted.Code != 200 {
		t.Fatal(accepted.Body.String())
	}
	outgoing := collaborationRequest(t, handler, alice.session, http.MethodGet, path, "")
	if !strings.Contains(outgoing.Body.String(), `"status":"accepted"`) {
		t.Fatal(outgoing.Body.String())
	}
	removed := collaborationRequest(t, handler, alice.session, http.MethodDelete, fmt.Sprintf("/api/portal/shared-projects/%s/members/%d", result.Project.ID, bob.user.ID), "")
	if removed.Code != 204 && removed.Code != 200 {
		t.Fatal(removed.Body.String())
	}
	for _, target := range []string{"/api/portal/shared-messages?conversation_id=" + result.Conversation.ID, "/api/portal/shared-workspaces/" + result.Project.ID + "/content?path=test.txt"} {
		denied := collaborationRequest(t, handler, bob.session, http.MethodGet, target, "")
		if denied.Code != 403 && denied.Code != 404 {
			t.Fatalf("removed member has access: %d %s", denied.Code, target)
		}
	}
}

func TestSharedContextIncludesFullIntervalBeyondTwoHundredMessages(t *testing.T) {
	handler, data, _, alice, bob := collaborationTestServer(t)
	id := sharedTurnConversation(t, handler, alice, bob)
	var last collaboration.Message
	for index := 0; index < 251; index++ {
		var err error
		last, err = data.AddMessage(t.Context(), collaboration.Message{ID: fmt.Sprintf("message-context-%06d", index), Conversation: id, Kind: "user", Body: fmt.Sprintf("讨论-%d", index), AuthorName: "alice"}, alice.user.ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	rows, err := data.UserMessagesRange(t.Context(), id, 0, last.Seq)
	if err != nil || len(rows) != 251 || rows[len(rows)-1].ID != last.ID {
		t.Fatalf("truncated context: %d %v", len(rows), err)
	}
}

func TestSharedAssistantIdentityCannotBeReplacedThroughHTTP(t *testing.T) {
	handler, data, _, alice, bob := collaborationTestServer(t)
	id := sharedTurnConversation(t, handler, alice, bob)
	message, err := data.AddMessage(t.Context(), collaboration.Message{ID: "message_http_lock_123", Conversation: id, AuthorName: "Alice", Kind: "user", Body: "Begin"}, alice.user.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err := data.ReserveAIRun(t.Context(), "run_http_lock_123456", message, alice.user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = data.FinishAIRun(t.Context(), run, "result_http_lock_123", "runtime-session", "A plan", nil); err != nil {
		t.Fatal(err)
	}
	read := collaborationRequest(t, handler, alice.session, http.MethodGet, "/api/portal/shared-conversations?id="+id, "")
	if read.Code != 200 || !strings.Contains(read.Body.String(), `"assistant_locked":true`) {
		t.Fatalf("lock not exposed: %s", read.Body.String())
	}
	for _, body := range []string{`{"assistant_id":"other","assistant_backend":"codex","model_id":"gpt-5","thinking_effort":"medium"}`, `{"assistant_id":""}`} {
		response := collaborationRequest(t, handler, alice.session, http.MethodPut, "/api/portal/shared-conversations/"+id+"/assistant", body)
		if response.Code != 409 || !strings.Contains(response.Body.String(), "shared_assistant_locked") {
			t.Fatalf("binding bypass: %d %s", response.Code, response.Body.String())
		}
	}
	response := collaborationRequest(t, handler, alice.session, http.MethodPatch, "/api/portal/shared-conversations", `{"conversation_id":"`+id+`","model_id":"gpt-5","thinking_effort":"high"}`)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"thinking_effort":"high"`) {
		t.Fatalf("model settings failed: %d %s", response.Code, response.Body.String())
	}
}
