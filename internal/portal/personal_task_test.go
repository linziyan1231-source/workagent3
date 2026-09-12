package portal

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestSharedPersonalTaskCreateVisibilityAndDelete(t *testing.T) {
	runtime := &fakePersonalTaskRuntime{sessions: map[string]json.RawMessage{}}
	handler, _, _, alice, bob := collaborationTestServer(t, func(s *Server) { s.personalTasks.runtime = runtime })
	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"个人任务"}`)
	var createdBody struct {
		Project      sharedProjectDTO      `json:"project"`
		Conversation sharedConversationDTO `json:"conversation"`
	}
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &createdBody) != nil {
		t.Fatalf("create project = %d %s", created.Code, created.Body.String())
	}
	if createdBody.Conversation.Kind != "discussion" || createdBody.Conversation.CreatorUserID != 0 || createdBody.Conversation.RuntimeSessionID != "" {
		t.Fatalf("default discussion changed: %#v", createdBody.Conversation)
	}
	projectID := createdBody.Project.ID
	runtime.sessions["session-12345678-1234-1234-1234-123456789012"] = json.RawMessage(`{"id":"session-12345678-1234-1234-1234-123456789012","workspaceId":"shared:` + projectID + `"}`)
	runtime.sessions["session-abcdefab-1234-1234-1234-123456789012"] = json.RawMessage(`{"id":"session-abcdefab-1234-1234-1234-123456789012","workspaceId":"shared:` + projectID + `"}`)
	invited := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects/"+projectID+"/invites", `{"targetUsername":"bob","expiresInHours":24}`)
	var inviteBody struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	if invited.Code != http.StatusCreated || json.Unmarshal(invited.Body.Bytes(), &inviteBody) != nil {
		t.Fatalf("invite = %d %s", invited.Code, invited.Body.String())
	}
	if accepted := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-invites/"+inviteBody.Invite.ID+"/accept", `{}`); accepted.Code != http.StatusOK {
		t.Fatalf("accept = %d %s", accepted.Code, accepted.Body.String())
	}

	// Assistant fields are ignored for personal tasks; the row only points at
	// the creator's own runtime session.
	body := `{"project_id":"` + projectID + `","name":"我的任务","kind":"personal_task","runtime_session_id":"session-12345678-1234-1234-1234-123456789012","operation_id":"operation-ptask-123456","assistant_id":"codex","assistant_backend":"codex","model_id":"gpt-5","thinking_effort":"medium"}`
	first := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-conversations", body)
	var result struct {
		Conversation sharedConversationDTO `json:"conversation"`
	}
	if first.Code != http.StatusCreated || json.Unmarshal(first.Body.Bytes(), &result) != nil {
		t.Fatalf("create personal task = %d %s", first.Code, first.Body.String())
	}
	task := result.Conversation
	if task.Kind != "personal_task" || task.CreatorUserID != alice.user.ID || task.RuntimeSessionID != "session-12345678-1234-1234-1234-123456789012" || task.AssistantID != "" || !strings.HasPrefix(task.ID, "ptask_") {
		t.Fatalf("personal task = %#v", task)
	}
	retry := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-conversations", body)
	var retried struct {
		Conversation sharedConversationDTO `json:"conversation"`
	}
	if retry.Code != http.StatusOK || json.Unmarshal(retry.Body.Bytes(), &retried) != nil || retried.Conversation.ID != task.ID {
		t.Fatalf("idempotent retry = %d %s", retry.Code, retry.Body.String())
	}
	conflict := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-conversations", strings.Replace(body, "session-12345678-1234-1234-1234-123456789012", "session-abcdefab-1234-1234-1234-123456789012", 1))
	if conflict.Code != http.StatusConflict {
		t.Fatalf("changed retry = %d %s", conflict.Code, conflict.Body.String())
	}

	listed := collaborationRequest(t, handler, alice.session, http.MethodGet, "/api/portal/shared-conversations", "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"id":"`+task.ID+`"`) {
		t.Fatalf("creator list = %d %s", listed.Code, listed.Body.String())
	}
	memberListed := collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/shared-conversations?include_hidden=1", "")
	if memberListed.Code != http.StatusOK || strings.Contains(memberListed.Body.String(), task.ID) {
		t.Fatalf("member list = %d %s", memberListed.Code, memberListed.Body.String())
	}
	if read := collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/shared-conversations?id="+task.ID, ""); read.Code != http.StatusNotFound {
		t.Fatalf("member read = %d %s", read.Code, read.Body.String())
	}

	if updated := collaborationRequest(t, handler, bob.session, http.MethodPatch, "/api/portal/shared-conversations", `{"conversation_id":"`+task.ID+`","model_id":"gpt-5","thinking_effort":"high"}`); updated.Code != http.StatusNotFound {
		t.Fatalf("member patched personal task = %d %s", updated.Code, updated.Body.String())
	}
	if updated := collaborationRequest(t, handler, alice.session, http.MethodPatch, "/api/portal/shared-conversations", `{"conversation_id":"`+task.ID+`","model_id":"gpt-5","thinking_effort":"high"}`); updated.Code != http.StatusBadRequest {
		t.Fatalf("personal task runtime update = %d %s", updated.Code, updated.Body.String())
	}
	if updated := collaborationRequest(t, handler, alice.session, http.MethodPatch, "/api/portal/shared-conversations", `{"conversation_id":"`+task.ID+`","pinned":true}`); updated.Code != http.StatusOK {
		t.Fatalf("personal task metadata update = %d %s", updated.Code, updated.Body.String())
	}

	if removed := collaborationRequest(t, handler, bob.session, http.MethodDelete, "/api/portal/shared-conversations", `{"conversation_id":"`+task.ID+`"}`); removed.Code != http.StatusNotFound {
		t.Fatalf("member delete = %d %s", removed.Code, removed.Body.String())
	}
	if removed := collaborationRequest(t, handler, alice.session, http.MethodDelete, "/api/portal/shared-conversations", `{"conversation_id":"`+task.ID+`"}`); removed.Code != http.StatusNoContent {
		t.Fatalf("creator delete = %d %s", removed.Code, removed.Body.String())
	}
	if read := collaborationRequest(t, handler, alice.session, http.MethodGet, "/api/portal/shared-conversations?id="+task.ID, ""); read.Code != http.StatusNotFound {
		t.Fatalf("deleted personal task read = %d %s", read.Code, read.Body.String())
	}
}

func TestSharedPersonalTaskCreationValidation(t *testing.T) {
	handler, _, _, alice, _ := collaborationTestServer(t)
	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"校验"}`)
	var createdBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &createdBody) != nil {
		t.Fatalf("create project = %d %s", created.Code, created.Body.String())
	}
	for _, body := range []string{
		`{"project_id":"` + createdBody.Project.ID + `","name":"无会话","kind":"personal_task"}`,
		`{"project_id":"` + createdBody.Project.ID + `","name":"错误类型","kind":"junk","runtime_session_id":"session-12345678-1234-1234-1234-123456789012"}`,
	} {
		if response := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-conversations", body); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid personal task = %d %s", response.Code, response.Body.String())
		}
	}
}
