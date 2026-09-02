package portal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/notifications"
	"workagent3/internal/store"
)

type collaborationModelAccess struct{}

func (collaborationModelAccess) ListAuthorized(context.Context, string) ([]contracts.AuthorizedModel, error) {
	return []contracts.AuthorizedModel{{Model: contracts.Model{ID: "gpt-5", ProviderID: "codex"}, Authorization: contracts.ModelAuthorization{ModelID: "gpt-5", Authorized: true}}}, nil
}

type fakeSharedProjectPlatform struct {
	provisionErr error
	grantErr     error
	revokeErr    error
	transferErr  error
	finalizeErr  error
	provisioned  []string
	granted      []string
	revoked      []string
	transferred  []string
	finalized    []string
	fileOwner    string
	fileRequest  SharedFileRequest
	fileRequests []SharedFileRequest
	previewOwner string
	previewData  OfficePreviewData
	previewErr   error
	turnOwner    string
	turnRequest  SharedTurnRequest
	cancelRunID  string
}

func (p *fakeSharedProjectPlatform) ProvisionProject(_ context.Context, projectID, _ string) error {
	p.provisioned = append(p.provisioned, projectID)
	return p.provisionErr
}

func (p *fakeSharedProjectPlatform) GrantProjectMember(_ context.Context, projectID, memberSID string) error {
	p.granted = append(p.granted, projectID+":"+memberSID)
	return p.grantErr
}

func (p *fakeSharedProjectPlatform) RevokeProjectMember(_ context.Context, projectID, memberSID string) error {
	p.revoked = append(p.revoked, projectID+":"+memberSID)
	return p.revokeErr
}

func (p *fakeSharedProjectPlatform) TransferProjectOwnership(_ context.Context, projectID, _, _ string, _ []string) error {
	p.transferred = append(p.transferred, projectID)
	return p.transferErr
}

func (p *fakeSharedProjectPlatform) FinalizeProjectOwnership(_ context.Context, projectID, ownerSID string, commit bool) error {
	p.finalized = append(p.finalized, projectID+":"+ownerSID+":"+strconv.FormatBool(commit))
	return p.finalizeErr
}

func (p *fakeSharedProjectPlatform) Operate(_ context.Context, ownerSID string, input SharedFileRequest) (json.RawMessage, error) {
	p.fileOwner, p.fileRequest = ownerSID, input
	p.fileRequests = append(p.fileRequests, input)
	switch input.Operation {
	case "metadata":
		return json.RawMessage(`{"name":"notes.md","path":"shared://project_1234567890/notes.md","size":5,"type":"text/markdown; charset=utf-8","lastModified":1788000000000,"isDirectory":false}`), nil
	case "read":
		return json.RawMessage(`"hello"`), nil
	case "write":
		return json.RawMessage(`true`), nil
	default:
		return json.RawMessage(`[{"name":"notes.md","type":"file"}]`), nil
	}
}

func (p *fakeSharedProjectPlatform) OperateOfficePreview(_ context.Context, ownerSID string, input SharedFileRequest) (OfficePreviewData, error) {
	p.previewOwner, p.fileRequest = ownerSID, input
	return p.previewData, p.previewErr
}

func (p *fakeSharedProjectPlatform) Run(_ context.Context, ownerSID string, input SharedTurnRequest) (SharedTurnResult, error) {
	p.turnOwner, p.turnRequest = ownerSID, input
	return SharedTurnResult{RunID: input.RunID, RuntimeSessionID: "session-shared-" + input.ConversationID, AssistantBody: "Shared answer"}, nil
}

func (p *fakeSharedProjectPlatform) Cancel(_ context.Context, _ string, runID string) error {
	p.cancelRunID = runID
	return nil
}

func TestCollaborationHTTPKeepsDatabaseAndACLConsistent(t *testing.T) {
	handler, collaborationData, platform, alice, bob := collaborationTestServer(t)

	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Design"}`)
	if created.Code != http.StatusCreated || strings.Contains(created.Body.String(), "S-1-") {
		t.Fatalf("create response = %d %s", created.Code, created.Body.String())
	}
	var createdBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil || createdBody.Project.State != "active" || len(platform.provisioned) != 1 {
		t.Fatalf("created body = %#v, platform = %#v, err = %v", createdBody, platform, err)
	}

	invited := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects/"+createdBody.Project.ID+"/invites", `{"targetUsername":"bob","expiresInHours":24}`)
	if invited.Code != http.StatusCreated || strings.Contains(invited.Body.String(), "S-1-") {
		t.Fatalf("invite response = %d %s", invited.Code, invited.Body.String())
	}
	var inviteBody struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	if err := json.Unmarshal(invited.Body.Bytes(), &inviteBody); err != nil {
		t.Fatal(err)
	}
	pending := collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/shared-invites", "")
	if pending.Code != http.StatusOK || !strings.Contains(pending.Body.String(), `"projectName":"Design"`) || !strings.Contains(pending.Body.String(), `"inviterName":"alice"`) || strings.Contains(pending.Body.String(), "S-1-") {
		t.Fatalf("pending invites = %d %s", pending.Code, pending.Body.String())
	}

	platform.grantErr = errors.New("injected ACL failure")
	failedAccept := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-invites/"+inviteBody.Invite.ID+"/accept", `{}`)
	if failedAccept.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed accept = %d %s", failedAccept.Code, failedAccept.Body.String())
	}
	if projects, err := collaborationData.ListProjects(t.Context(), bob.user.ID, true); err != nil || len(projects) != 0 {
		t.Fatalf("ACL failure granted database access: %#v, %v", projects, err)
	}
	storedInvite, err := collaborationData.Invite(t.Context(), inviteBody.Invite.ID)
	if err != nil || storedInvite.Status != "pending" {
		t.Fatalf("rolled-back invite = %#v, %v", storedInvite, err)
	}

	platform.grantErr = nil
	accepted := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-invites/"+inviteBody.Invite.ID+"/accept", `{}`)
	if accepted.Code != http.StatusOK || strings.Contains(accepted.Body.String(), "S-1-") {
		t.Fatalf("accept response = %d %s", accepted.Code, accepted.Body.String())
	}

	platform.revokeErr = errors.New("injected ACL failure")
	failedRemoval := collaborationRequest(t, handler, alice.session, http.MethodDelete, "/api/portal/shared-projects/"+createdBody.Project.ID+"/members/"+strconv.FormatInt(bob.user.ID, 10), "")
	if failedRemoval.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed removal = %d %s", failedRemoval.Code, failedRemoval.Body.String())
	}
	if projects, err := collaborationData.ListProjects(t.Context(), bob.user.ID, true); err != nil || len(projects) != 1 {
		t.Fatalf("ACL rollback did not restore database access: %#v, %v", projects, err)
	}

	platform.revokeErr = nil
	removed := collaborationRequest(t, handler, alice.session, http.MethodDelete, "/api/portal/shared-projects/"+createdBody.Project.ID+"/members/"+strconv.FormatInt(bob.user.ID, 10), "")
	if removed.Code != http.StatusNoContent {
		t.Fatalf("remove response = %d %s", removed.Code, removed.Body.String())
	}
	if projects, err := collaborationData.ListProjects(t.Context(), bob.user.ID, true); err != nil || len(projects) != 0 {
		t.Fatalf("removed member retained database access: %#v, %v", projects, err)
	}
}

func TestSharedFilesAuthorizeMembershipAndRouteToOwnerRuntime(t *testing.T) {
	handler, collaborationData, platform, alice, bob := collaborationTestServer(t)
	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Files"}`)
	var createdBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	if json.Unmarshal(created.Body.Bytes(), &createdBody) != nil {
		t.Fatal("decode project")
	}
	response := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-files", `{"project_id":"`+createdBody.Project.ID+`","operation":"dir","path":"shared://`+createdBody.Project.ID+`"}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"notes.md"`) {
		t.Fatalf("shared file response = %d %s", response.Code, response.Body.String())
	}
	var fileResponse struct {
		Success bool                     `json:"success"`
		Data    []map[string]interface{} `json:"data"`
	}
	if json.Unmarshal(response.Body.Bytes(), &fileResponse) != nil || !fileResponse.Success || len(fileResponse.Data) != 1 || fileResponse.Data[0]["name"] != "notes.md" {
		t.Fatalf("shared file response was not preserved as structured JSON: %s", response.Body.String())
	}
	if platform.fileOwner != alice.user.SID || platform.fileRequest.ProjectID != createdBody.Project.ID {
		t.Fatalf("owner routing = %q %#v", platform.fileOwner, platform.fileRequest)
	}
	forbidden := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-files", `{"project_id":"`+createdBody.Project.ID+`","operation":"list"}`)
	if forbidden.Code != http.StatusNotFound || platform.fileOwner != alice.user.SID {
		t.Fatalf("non-member response = %d %s", forbidden.Code, forbidden.Body.String())
	}

	invited := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects/"+createdBody.Project.ID+"/invites", `{"targetUsername":"bob","expiresInHours":24}`)
	var inviteBody struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	if invited.Code != http.StatusCreated || json.Unmarshal(invited.Body.Bytes(), &inviteBody) != nil {
		t.Fatalf("invite response = %d %s", invited.Code, invited.Body.String())
	}
	if accepted := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-invites/"+inviteBody.Invite.ID+"/accept", `{}`); accepted.Code != http.StatusOK {
		t.Fatalf("accept response = %d %s", accepted.Code, accepted.Body.String())
	}
	for _, operation := range []string{"metadata", "read", "write"} {
		body := `{"project_id":"` + createdBody.Project.ID + `","operation":"` + operation + `","path":"notes.md"`
		if operation == "write" {
			body += `,"data":"updated"`
		}
		response := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-files", body+`}`)
		if response.Code != http.StatusOK {
			t.Fatalf("member %s response = %d %s", operation, response.Code, response.Body.String())
		}
	}
	if platform.fileOwner != alice.user.SID || len(platform.fileRequests) != 4 || platform.fileRequests[1].Operation != "metadata" || platform.fileRequests[2].Operation != "read" || platform.fileRequests[3].Data != "updated" {
		t.Fatalf("member file routing = owner %q requests %#v", platform.fileOwner, platform.fileRequests)
	}
	removed := collaborationRequest(t, handler, alice.session, http.MethodDelete, "/api/portal/shared-projects/"+createdBody.Project.ID+"/members/"+strconv.FormatInt(bob.user.ID, 10), "")
	if removed.Code != http.StatusNoContent {
		t.Fatalf("remove response = %d %s", removed.Code, removed.Body.String())
	}
	if projects, err := collaborationData.ListProjects(t.Context(), bob.user.ID, true); err != nil || len(projects) != 0 {
		t.Fatalf("removed member retained project access: %#v, %v", projects, err)
	}
	afterRemoval := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-files", `{"project_id":"`+createdBody.Project.ID+`","operation":"read","path":"notes.md"}`)
	if afterRemoval.Code != http.StatusNotFound || len(platform.fileRequests) != 4 {
		t.Fatalf("removed member file response = %d %s requests=%#v", afterRemoval.Code, afterRemoval.Body.String(), platform.fileRequests)
	}
}

func TestCollaborationProjectProvisionFailureCompensates(t *testing.T) {
	handler, collaborationData, platform, alice, _ := collaborationTestServer(t)
	platform.provisionErr = errors.New("injected provision failure")

	response := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Broken"}`)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	projects, err := collaborationData.ListProjects(t.Context(), alice.user.ID, true)
	if err != nil || len(projects) != 0 {
		t.Fatalf("failed provision retained project: %#v, %v", projects, err)
	}
}

func TestCollaborationConversationMessageAndSSEReplay(t *testing.T) {
	handler, _, platform, alice, bob := collaborationTestServer(t)
	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Realtime"}`)
	var projectBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &projectBody); err != nil {
		t.Fatal(err)
	}
	invited := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects/"+projectBody.Project.ID+"/invites", `{"targetUsername":"bob","expiresInHours":24}`)
	var inviteBody struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	if err := json.Unmarshal(invited.Body.Bytes(), &inviteBody); err != nil {
		t.Fatal(err)
	}
	if accepted := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-invites/"+inviteBody.Invite.ID+"/accept", `{}`); accepted.Code != http.StatusOK {
		t.Fatalf("accept = %d %s", accepted.Code, accepted.Body.String())
	}
	conversation := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-conversations", `{"project_id":"`+projectBody.Project.ID+`","name":"Review","assistant_id":"codex","assistant_backend":"codex","model_id":"gpt-5","thinking_effort":"medium"}`)
	if conversation.Code != http.StatusCreated {
		t.Fatalf("create conversation = %d %s", conversation.Code, conversation.Body.String())
	}
	var conversationBody struct {
		Conversation sharedConversationDTO `json:"conversation"`
	}
	if err := json.Unmarshal(conversation.Body.Bytes(), &conversationBody); err != nil {
		t.Fatal(err)
	}
	message := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-messages", `{"conversation_id":"`+conversationBody.Conversation.ID+`","body":"Hello Bob","mentions":[],"attachments":[]}`)
	if message.Code != http.StatusCreated || !strings.Contains(message.Body.String(), `"ai_started":false`) {
		t.Fatalf("create message = %d %s", message.Code, message.Body.String())
	}
	listed := collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/shared-messages?conversation_id="+conversationBody.Conversation.ID, "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"body":"Hello Bob"`) || strings.Contains(listed.Body.String(), `"is_current_user":true`) {
		t.Fatalf("member messages = %d %s", listed.Code, listed.Body.String())
	}
	updated := collaborationRequest(t, handler, bob.session, http.MethodPatch, "/api/portal/shared-conversations", `{"conversation_id":"`+conversationBody.Conversation.ID+`","name":"Renamed","pinned":true}`)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"name":"Renamed"`) || !strings.Contains(updated.Body.String(), `"pinned":true`) {
		t.Fatalf("updated conversation = %d %s", updated.Code, updated.Body.String())
	}
	ownerView := collaborationRequest(t, handler, alice.session, http.MethodGet, "/api/portal/shared-conversations?id="+conversationBody.Conversation.ID, "")
	if ownerView.Code != http.StatusOK || strings.Contains(ownerView.Body.String(), `"pinned":true`) {
		t.Fatalf("member pin leaked to owner = %d %s", ownerView.Code, ownerView.Body.String())
	}
	runtimeUpdated := collaborationRequest(t, handler, bob.session, http.MethodPatch, "/api/portal/shared-conversations", `{"conversation_id":"`+conversationBody.Conversation.ID+`","model_id":"gpt-5","thinking_effort":"high"}`)
	if runtimeUpdated.Code != http.StatusOK || !strings.Contains(runtimeUpdated.Body.String(), `"thinking_effort":"high"`) {
		t.Fatalf("updated shared runtime = %d %s", runtimeUpdated.Code, runtimeUpdated.Body.String())
	}
	aiMessage := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-messages", `{"conversation_id":"`+conversationBody.Conversation.ID+`","body":"Please answer","mentions":[{"kind":"assistant","id":"codex"}],"attachments":[]}`)
	if aiMessage.Code != http.StatusCreated || !strings.Contains(aiMessage.Body.String(), `"ai_started":true`) {
		t.Fatalf("AI message = %d %s", aiMessage.Code, aiMessage.Body.String())
	}
	deadline := time.Now().Add(time.Second)
	for platform.turnOwner == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if platform.turnOwner != alice.user.SID || platform.turnRequest.Context == "" || platform.turnRequest.RecoveryContext == "" {
		t.Fatalf("shared turn = owner %q request %#v", platform.turnOwner, platform.turnRequest)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		listed = collaborationRequest(t, handler, bob.session, http.MethodGet, "/api/portal/shared-messages?conversation_id="+conversationBody.Conversation.ID, "")
		if strings.Contains(listed.Body.String(), `"body":"Shared answer"`) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !strings.Contains(listed.Body.String(), `"body":"Shared answer"`) {
		t.Fatalf("shared AI result = %d %s", listed.Code, listed.Body.String())
	}

	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	streamRequest := httptest.NewRequest(http.MethodGet, "/api/portal/shared-events", nil).WithContext(ctx)
	streamRequest.Header.Set("Last-Event-ID", "0")
	streamRequest.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: bob.session})
	stream := httptest.NewRecorder()
	handler.ServeHTTP(stream, streamRequest)
	if stream.Code != http.StatusOK || !strings.Contains(stream.Body.String(), "id: 1\n") || !strings.Contains(stream.Body.String(), `"event":"message.stream"`) || !strings.Contains(stream.Body.String(), `shared:`+conversationBody.Conversation.ID) {
		t.Fatalf("SSE replay = %d %s", stream.Code, stream.Body.String())
	}
}

type collaborationTestUser struct {
	user    store.User
	session string
}

// The shared_invite notification must deep-link to the invite popover (the
// Team notifications popup), not a placeholder path.
func TestSharedInviteNotificationDeepLinksToInvitePopover(t *testing.T) {
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
	notices, err := notifications.Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = notices.Close() })
	hash, err := auth.HashPassword([]byte("test-password"))
	if err != nil {
		t.Fatal(err)
	}
	alice, err := users.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := users.CreateUser(t.Context(), "bob", "S-1-5-21-2000", hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(t.Context(), "alice-session", alice.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	platform := &fakeSharedProjectPlatform{}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{ModelAccess: collaborationModelAccess{}, Collaboration: collaborationData, SharedProjects: platform, SharedFiles: platform, SharedTurns: platform, Notifications: notices})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()

	created := collaborationRequest(t, handler, "alice-session", http.MethodPost, "/api/portal/shared-projects", `{"name":"Design"}`)
	var createdBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil {
		t.Fatal(err)
	}
	invited := collaborationRequest(t, handler, "alice-session", http.MethodPost, "/api/portal/shared-projects/"+createdBody.Project.ID+"/invites", `{"targetUsername":"bob","expiresInHours":24}`)
	if invited.Code != http.StatusCreated {
		t.Fatalf("invite response = %d %s", invited.Code, invited.Body.String())
	}
	feed, err := notices.List(t.Context(), bob.SID, 10)
	if err != nil || len(feed) != 1 {
		t.Fatalf("bob feed = %#v, %v", feed, err)
	}
	if feed[0].Kind != "shared_invite" || feed[0].DeepLink != "/guid?open=shared-invites" {
		t.Fatalf("invite notification = %#v", feed[0])
	}
}

func collaborationTestServer(t *testing.T) (http.Handler, *collaboration.Store, *fakeSharedProjectPlatform, collaborationTestUser, collaborationTestUser) {
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
	alice := create("alice", "S-1-5-21-1000", "alice-collaboration-session")
	bob := create("bob", "S-1-5-21-2000", "bob-collaboration-session")
	platform := &fakeSharedProjectPlatform{}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{ModelAccess: collaborationModelAccess{}, Collaboration: collaborationData, SharedProjects: platform, SharedFiles: platform, SharedTurns: platform})
	if err != nil {
		t.Fatal(err)
	}
	return server.Handler(), collaborationData, platform, alice, bob
}

func collaborationRequest(t *testing.T, handler http.Handler, session, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://portal.test"+path, bytes.NewBufferString(body))
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: session})
	if method != http.MethodGet {
		request.Header.Set("Origin", "http://portal.test")
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
