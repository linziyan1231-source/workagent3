package portal

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/notifications"
	"workagent3/internal/store"
)

type inviteLinkFixture struct {
	handler  http.Handler
	platform *fakeSharedProjectPlatform
	audits   *audit.Store
	notices  *notifications.Store
	alice    collaborationTestUser
	bob      collaborationTestUser
	carol    collaborationTestUser
}

func inviteLinkTestServer(t *testing.T) inviteLinkFixture {
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
	auditStore, err := audit.Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = auditStore.Close() })
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
	platform := &fakeSharedProjectPlatform{}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{
		ModelAccess: collaborationModelAccess{}, Collaboration: collaborationData,
		SharedProjects: platform, SharedFiles: platform, SharedTurns: platform,
		Audit: auditStore, Notifications: notices,
	})
	if err != nil {
		t.Fatal(err)
	}
	return inviteLinkFixture{
		handler: server.Handler(), platform: platform, audits: auditStore, notices: notices,
		alice: create("alice", "S-1-5-21-1000", "alice-link-session"),
		bob:   create("bob", "S-1-5-21-2000", "bob-link-session"),
		carol: create("carol", "S-1-5-21-3000", "carol-link-session"),
	}
}

func (f inviteLinkFixture) createProject(t *testing.T) string {
	t.Helper()
	created := collaborationRequest(t, f.handler, f.alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Design"}`)
	var body struct {
		Project sharedProjectDTO `json:"project"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil || created.Code != http.StatusCreated {
		t.Fatalf("create project = %d %s", created.Code, created.Body.String())
	}
	return body.Project.ID
}

func (f inviteLinkFixture) createLink(t *testing.T, projectID, body string) sharedInviteLinkDTO {
	t.Helper()
	created := collaborationRequest(t, f.handler, f.alice.session, http.MethodPost, "/api/portal/shared-projects/"+projectID+"/invite-links", body)
	var parsed struct {
		Link sharedInviteLinkDTO `json:"link"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &parsed); err != nil || created.Code != http.StatusCreated {
		t.Fatalf("create link = %d %s", created.Code, created.Body.String())
	}
	if parsed.Link.Token == "" || strings.Contains(created.Body.String(), "S-1-") {
		t.Fatalf("link body leaks or lacks token: %s", created.Body.String())
	}
	return parsed.Link
}

func (f inviteLinkFixture) accept(t *testing.T, session, token string) *struct {
	Code int
	Body string
} {
	response := collaborationRequest(t, f.handler, session, http.MethodPost, "/api/portal/shared-invite-links/accept", `{"token":"`+token+`"}`)
	return &struct {
		Code int
		Body string
	}{response.Code, response.Body.String()}
}

func TestSharedInviteLinkAcceptanceTransaction(t *testing.T) {
	fixture := inviteLinkTestServer(t)
	projectID := fixture.createProject(t)
	link := fixture.createLink(t, projectID, `{}`)
	if link.SingleUse || link.Status != "active" {
		t.Fatalf("link = %#v", link)
	}

	accepted := fixture.accept(t, fixture.bob.session, link.Token)
	if accepted.Code != http.StatusOK || !strings.Contains(accepted.Body, `"id":"`+projectID+`"`) {
		t.Fatalf("accept = %d %s", accepted.Code, accepted.Body)
	}
	if len(fixture.platform.granted) != 1 || fixture.platform.granted[0] != projectID+":"+fixture.bob.user.SID {
		t.Fatalf("grants = %#v", fixture.platform.granted)
	}
	if again := fixture.accept(t, fixture.carol.session, link.Token); again.Code != http.StatusOK {
		t.Fatalf("multi-use second accept = %d %s", again.Code, again.Body)
	}

	notices, err := fixture.notices.List(t.Context(), fixture.alice.user.SID, 10)
	if err != nil || len(notices) == 0 || notices[0].Kind != "shared_member" || !strings.Contains(notices[0].Message, "joined") {
		t.Fatalf("owner notifications = %#v, %v", notices, err)
	}

	for _, action := range []string{audit.ActionCollaborationInviteLinkCreate, audit.ActionCollaborationInviteLinkAccept, audit.ActionCollaborationACLGrant} {
		events, err := fixture.audits.List(t.Context(), contracts.AuditQuery{Action: action})
		if err != nil || len(events) == 0 {
			t.Fatalf("audit %s = %#v, %v", action, events, err)
		}
		if events[0].Target != projectID {
			t.Fatalf("audit %s target = %#v", action, events[0])
		}
	}

	if repeat := fixture.accept(t, fixture.bob.session, link.Token); repeat.Code != http.StatusConflict {
		t.Fatalf("repeat accept = %d %s", repeat.Code, repeat.Body)
	}
}

func TestSharedInviteLinkFailureBranches(t *testing.T) {
	fixture := inviteLinkTestServer(t)
	projectID := fixture.createProject(t)

	if unknown := fixture.accept(t, fixture.bob.session, "invite_link_unknown_1234567"); unknown.Code != http.StatusNotFound || !strings.Contains(unknown.Body, "shared_invite_link_not_found") {
		t.Fatalf("unknown token = %d %s", unknown.Code, unknown.Body)
	}

	single := fixture.createLink(t, projectID, `{"singleUse":true}`)
	if !single.SingleUse {
		t.Fatalf("single-use link = %#v", single)
	}
	if accepted := fixture.accept(t, fixture.bob.session, single.Token); accepted.Code != http.StatusOK {
		t.Fatalf("single-use accept = %d %s", accepted.Code, accepted.Body)
	}
	if exhausted := fixture.accept(t, fixture.carol.session, single.Token); exhausted.Code != http.StatusGone || !strings.Contains(exhausted.Body, "shared_invite_link_exhausted") {
		t.Fatalf("exhausted accept = %d %s", exhausted.Code, exhausted.Body)
	}

	revoked := fixture.createLink(t, projectID, `{}`)
	if nonOwner := collaborationRequest(t, fixture.handler, fixture.bob.session, http.MethodDelete, "/api/portal/shared-projects/"+projectID+"/invite-links/"+revoked.Token, ""); nonOwner.Code != http.StatusForbidden {
		t.Fatalf("non-owner revoke = %d %s", nonOwner.Code, nonOwner.Body.String())
	}
	if removed := collaborationRequest(t, fixture.handler, fixture.alice.session, http.MethodDelete, "/api/portal/shared-projects/"+projectID+"/invite-links/"+revoked.Token, ""); removed.Code != http.StatusNoContent {
		t.Fatalf("revoke = %d %s", removed.Code, removed.Body.String())
	}
	if gone := fixture.accept(t, fixture.carol.session, revoked.Token); gone.Code != http.StatusGone || !strings.Contains(gone.Body, "shared_invite_link_revoked") {
		t.Fatalf("revoked accept = %d %s", gone.Code, gone.Body)
	}
	events, err := fixture.audits.List(t.Context(), contracts.AuditQuery{Action: audit.ActionCollaborationInviteLinkRevoke})
	if err != nil || len(events) != 1 || events[0].Actor != "alice" || events[0].Target != projectID {
		t.Fatalf("revoke audit = %#v, %v", events, err)
	}

	if forbidden := collaborationRequest(t, fixture.handler, fixture.bob.session, http.MethodPost, "/api/portal/shared-projects/"+projectID+"/invite-links", `{}`); forbidden.Code != http.StatusForbidden {
		t.Fatalf("non-owner create = %d %s", forbidden.Code, forbidden.Body.String())
	}
	if invalid := collaborationRequest(t, fixture.handler, fixture.alice.session, http.MethodPost, "/api/portal/shared-projects/"+projectID+"/invite-links", `{"expiresInHours":0}`); invalid.Code != http.StatusCreated {
		t.Fatalf("default expiry create = %d %s", invalid.Code, invalid.Body.String())
	}
	if outOfRange := collaborationRequest(t, fixture.handler, fixture.alice.session, http.MethodPost, "/api/portal/shared-projects/"+projectID+"/invite-links", `{"expiresInHours":10000}`); outOfRange.Code != http.StatusBadRequest {
		t.Fatalf("out-of-range expiry = %d %s", outOfRange.Code, outOfRange.Body.String())
	}
}
