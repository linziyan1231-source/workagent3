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
	"workagent3/internal/store"
)

type fakeSharedProjectPlatform struct {
	provisionErr error
	grantErr     error
	revokeErr    error
	transferErr  error
	provisioned  []string
	granted      []string
	revoked      []string
	transferred  []string
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

func (p *fakeSharedProjectPlatform) FinalizeProjectOwnership(context.Context, string, string, bool) error {
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

type collaborationTestUser struct {
	user    store.User
	session string
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
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{Collaboration: collaborationData, SharedProjects: platform})
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
