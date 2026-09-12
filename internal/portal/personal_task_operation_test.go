package portal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"workagent3/internal/collaboration"
)

type fakePersonalTaskRuntime struct {
	sessions                                        map[string]json.RawMessage
	created                                         map[string]string
	createCalls, deleteCalls                        int
	loseCreateResponse, loseDeleteResponse, offline bool
	createError                                     error
	beforeCreate                                    func()
}

func (p *fakePersonalTaskRuntime) Create(_ context.Context, op collaboration.PersonalTaskOperation) (json.RawMessage, error) {
	p.createCalls++
	if p.beforeCreate != nil {
		p.beforeCreate()
	}
	if p.createError != nil {
		return nil, p.createError
	}
	if p.offline {
		return nil, errors.New("runtime_offline")
	}
	if p.created == nil {
		p.created = map[string]string{}
		p.sessions = map[string]json.RawMessage{}
	}
	id := p.created[op.ID]
	if id == "" {
		id = "session-op-" + op.ID
		p.created[op.ID] = id
		p.sessions[id] = json.RawMessage(`{"id":"` + id + `","workspaceId":"shared:` + op.ProjectID + `"}`)
	}
	if p.loseCreateResponse {
		p.loseCreateResponse = false
		return nil, errors.New("response_lost")
	}
	return p.sessions[id], nil
}
func (p *fakePersonalTaskRuntime) Read(_ context.Context, sid, id string) (json.RawMessage, error) {
	if data, ok := p.sessions[id]; ok {
		return data, nil
	}
	return nil, errors.New("missing_session")
}
func (p *fakePersonalTaskRuntime) Delete(_ context.Context, op collaboration.PersonalTaskOperation) error {
	p.deleteCalls++
	if p.offline {
		return errors.New("runtime_offline")
	}
	delete(p.sessions, op.RuntimeSessionID)
	if p.loseDeleteResponse {
		p.loseDeleteResponse = false
		return errors.New("delete_response_lost")
	}
	return nil
}

func TestPersonalTaskRecoversLostResponsesAndOfflineDeletion(t *testing.T) {
	runtime := &fakePersonalTaskRuntime{loseCreateResponse: true}
	var server *Server
	handler, data, _, alice, bob := collaborationTestServer(t, func(s *Server) { server = s; s.personalTasks.runtime = runtime })
	project := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Recovery"}`)
	var projectBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	if json.Unmarshal(project.Body.Bytes(), &projectBody) != nil {
		t.Fatal(project.Body.String())
	}
	body := `{"operation_id":"operation-durable-1234","project_id":"` + projectBody.Project.ID + `","options":{"title":"Durable","engine":"kimi","presetId":"builtin-kimi","modelId":"kimi-k2","permissionMode":"workspace_write"}}`
	first := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-personal-tasks", body)
	if first.Code != 202 {
		t.Fatalf("first = %d %s", first.Code, first.Body.String())
	}
	var result struct {
		Operation collaboration.PersonalTaskOperation `json:"operation"`
	}
	_ = json.Unmarshal(first.Body.Bytes(), &result)
	if result.Operation.State != "creating" || len(runtime.sessions) != 1 {
		t.Fatalf("lost response: %#v %#v", result, runtime.sessions)
	}
	rows, _ := data.ListConversations(t.Context(), alice.user.ID, false)
	for _, row := range rows {
		if row.Kind == "personal_task" {
			t.Fatal("pointer published before session acknowledgement")
		}
	}
	// Reconstruct the application service as a Portal restart would do. Its
	// only recovery input is the SQLite intent, not an in-memory promise.
	server.personalTasks = &personalTaskService{store: data, runtime: runtime, users: server.store}
	pending, _ := data.PendingPersonalTasks(t.Context())
	if len(pending) != 1 {
		t.Fatal(pending)
	}
	op, err := server.personalTasks.advance(t.Context(), pending[0])
	if err != nil || op.State != "ready" || len(runtime.sessions) != 1 {
		t.Fatalf("recovered %#v %v", op, err)
	}
	retry := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-personal-tasks", body)
	if retry.Code != 200 || runtime.createCalls != 2 {
		t.Fatalf("retry %d %s calls=%d", retry.Code, retry.Body.String(), runtime.createCalls)
	}
	if leaked := collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/shared-personal-tasks?id="+op.ID, ""); leaked.Code != 404 {
		t.Fatalf("other user sees operation: %d", leaked.Code)
	}
	if remove := collaborationRequest(t, handler, bob.session, http.MethodDelete, "/api/portal/shared-personal-tasks", `{"conversation_id":"`+op.ID+`"}`); remove.Code != 404 {
		t.Fatal(remove.Body.String())
	}
	runtime.offline = true
	removed := collaborationRequest(t, handler, alice.session, http.MethodDelete, "/api/portal/shared-personal-tasks", `{"conversation_id":"`+op.ID+`"}`)
	if removed.Code != 202 {
		t.Fatalf("offline delete %d %s", removed.Code, removed.Body.String())
	}
	if _, err := data.ConversationForUser(t.Context(), op.ID, alice.user.ID, true); err != nil {
		t.Fatal("deleted pointer before runtime acknowledgement")
	}
	runtime.offline = false
	runtime.loseDeleteResponse = true
	op, _ = data.PersonalTaskOperation(t.Context(), op.ID, alice.user.ID)
	op, err = server.personalTasks.advance(t.Context(), op)
	if err != nil || op.State != "deleting" {
		t.Fatalf("lost delete %#v %v", op, err)
	}
	server.personalTasks = &personalTaskService{store: data, runtime: runtime, users: server.store}
	op, err = server.personalTasks.advance(t.Context(), op)
	if err != nil || op.State != "deleted" || len(runtime.sessions) != 0 {
		t.Fatalf("delete recovery %#v %v", op, err)
	}
	if _, err := data.ConversationForUser(t.Context(), op.ID, alice.user.ID, true); !errors.Is(err, collaboration.ErrNotFound) {
		t.Fatal(err)
	}
	if again := collaborationRequest(t, handler, alice.session, http.MethodDelete, "/api/portal/shared-conversations", `{"conversation_id":"`+op.ID+`"}`); again.Code != 204 {
		t.Fatalf("old delete retry %d %s", again.Code, again.Body.String())
	}
	if resurrect := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-personal-tasks", body); resurrect.Code != 410 {
		t.Fatalf("resurrect %d %s", resurrect.Code, resurrect.Body.String())
	}
}

func TestPersonalTaskCreationCancellationStillLeavesRecoverableIntent(t *testing.T) {
	runtime := &fakePersonalTaskRuntime{offline: true}
	var server *Server
	handler, data, _, alice, _ := collaborationTestServer(t, func(s *Server) { server = s; s.personalTasks.runtime = runtime })
	project := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Cancel"}`)
	var body struct {
		Project sharedProjectDTO `json:"project"`
	}
	_ = json.Unmarshal(project.Body.Bytes(), &body)
	op, err := data.BeginPersonalTask(t.Context(), collaboration.PersonalTaskOperation{ID: "ptask_cancellation_12345", UserID: alice.user.ID, CreatorSID: alice.user.SID, ProjectID: body.Project.ID, Name: "Task", Configuration: json.RawMessage(`{"engine":"kimi","title":"Task"}`)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = server.personalTasks.advance(ctx, op)
	if !errors.Is(err, context.Canceled) || runtime.createCalls != 0 {
		t.Fatalf("cancelled %v calls=%d", err, runtime.createCalls)
	}
	op, err = data.BeginPersonalTaskDeletion(t.Context(), op.ID, alice.user.ID, alice.user.SID)
	if err != nil {
		t.Fatal(err)
	}
	runtime.offline = false
	op, err = server.personalTasks.advance(t.Context(), op)
	if err != nil || op.State != "deleted" || len(runtime.sessions) != 0 {
		t.Fatalf("cancel create %#v %v", op, err)
	}
	// A stopped recovery loop never launches a queued item.
	server.RunPersonalTaskRecovery(ctx, time.Millisecond)
	if runtime.createCalls != 0 {
		t.Fatal(runtime.createCalls)
	}
}

func TestPersonalTaskArchiveDuringCreationCompensatesDurably(t *testing.T) {
	runtime := &fakePersonalTaskRuntime{loseDeleteResponse: true}
	var server *Server
	handler, data, _, alice, _ := collaborationTestServer(t, func(s *Server) { server = s; s.personalTasks.runtime = runtime })
	project := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Archive race"}`)
	var projectBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	_ = json.Unmarshal(project.Body.Bytes(), &projectBody)
	runtime.beforeCreate = func() {
		if err := data.ArchiveProject(t.Context(), projectBody.Project.ID, alice.user.ID); err != nil {
			t.Fatal(err)
		}
	}
	response := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-personal-tasks", `{"operation_id":"archive-during-create-1234","project_id":"`+projectBody.Project.ID+`","options":{"title":"Task","engine":"kimi"}}`)
	if response.Code != 202 {
		t.Fatalf("archive race = %d %s", response.Code, response.Body.String())
	}
	var result struct {
		Operation collaboration.PersonalTaskOperation `json:"operation"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	if result.Operation.State != "deleting" || runtime.createCalls != 1 || runtime.deleteCalls != 1 {
		t.Fatalf("compensation not recorded: %#v", result)
	}
	if _, err := data.ConversationForUser(t.Context(), result.Operation.ID, alice.user.ID, true); !errors.Is(err, collaboration.ErrNotFound) {
		t.Fatalf("archived task was published: %v", err)
	}
	server.personalTasks = &personalTaskService{store: data, runtime: runtime, users: server.store}
	op, err := data.PersonalTaskOperation(t.Context(), result.Operation.ID, alice.user.ID)
	if err != nil {
		t.Fatal(err)
	}
	op, err = server.personalTasks.advance(t.Context(), op)
	if err != nil || op.State != "deleted" || len(runtime.sessions) != 0 || runtime.createCalls != 1 {
		t.Fatalf("compensation recovery %#v %v", op, err)
	}
}

func TestPersonalTaskNormalRuntimeDeleteUsesDurableOwner(t *testing.T) {
	runtime := &fakePersonalTaskRuntime{}
	handler, data, _, alice, _ := collaborationTestServer(t, func(s *Server) { s.personalTasks.runtime = runtime })
	project := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Normal menu"}`)
	var projectBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	_ = json.Unmarshal(project.Body.Bytes(), &projectBody)
	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-personal-tasks", `{"operation_id":"normal-runtime-delete-1234","project_id":"`+projectBody.Project.ID+`","options":{"title":"Task","engine":"kimi"}}`)
	if created.Code != 200 {
		t.Fatalf("create %d %s", created.Code, created.Body.String())
	}
	var result struct {
		Operation collaboration.PersonalTaskOperation `json:"operation"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &result)
	removed := collaborationRequest(t, handler, alice.session, http.MethodDelete, "/api/runtime/v1/sessions/"+result.Operation.RuntimeSessionID, "")
	if removed.Code != 204 || runtime.deleteCalls != 1 {
		t.Fatalf("normal menu delete %d %s calls=%d", removed.Code, removed.Body.String(), runtime.deleteCalls)
	}
	op, err := data.PersonalTaskOperation(t.Context(), result.Operation.ID, alice.user.ID)
	if err != nil || op.State != "deleted" {
		t.Fatalf("owner was bypassed %#v %v", op, err)
	}
}
