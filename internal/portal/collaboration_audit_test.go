package portal

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

// TestCollaborationBusinessAuditEvents asserts the ACL grant/revoke and
// ownership transfer events the Portal writes for shared-project membership
// changes.
func TestCollaborationBusinessAuditEvents(t *testing.T) {
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
	alice := create("alice", "S-1-5-21-1000", "alice-audit-session")
	bob := create("bob", "S-1-5-21-2000", "bob-audit-session")
	platform := &fakeSharedProjectPlatform{}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{ModelAccess: collaborationModelAccess{}, Collaboration: collaborationData, SharedProjects: platform, SharedFiles: platform, SharedTurns: platform, Audit: auditStore})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()

	created := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects", `{"name":"Design"}`)
	var createdBody struct {
		Project sharedProjectDTO `json:"project"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil || created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	projectID := createdBody.Project.ID
	invited := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects/"+projectID+"/invites", `{"targetUsername":"bob","expiresInHours":24}`)
	var inviteBody struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	if err := json.Unmarshal(invited.Body.Bytes(), &inviteBody); err != nil || invited.Code != http.StatusCreated {
		t.Fatalf("invite = %d %s", invited.Code, invited.Body.String())
	}
	if accepted := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-invites/"+inviteBody.Invite.ID+"/accept", `{}`); accepted.Code != http.StatusOK {
		t.Fatalf("accept = %d %s", accepted.Code, accepted.Body.String())
	}

	grants, err := auditStore.List(t.Context(), contracts.AuditQuery{Action: audit.ActionCollaborationACLGrant})
	if err != nil || len(grants) != 1 {
		t.Fatalf("grants=%#v err=%v", grants, err)
	}
	if grants[0].Actor != "bob" || grants[0].Target != projectID || grants[0].Result != "success" || grants[0].CorrelationID == "" || grants[0].Metadata["member_sid"] != bob.user.SID {
		t.Fatalf("unexpected grant event: %#v", grants[0])
	}

	transferred := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-projects/"+projectID+"/ownership", `{"targetUsername":"bob"}`)
	if transferred.Code != http.StatusOK {
		t.Fatalf("transfer = %d %s", transferred.Code, transferred.Body.String())
	}
	transfers, err := auditStore.List(t.Context(), contracts.AuditQuery{Action: audit.ActionCollaborationOwnershipTransfer})
	if err != nil || len(transfers) != 1 {
		t.Fatalf("transfers=%#v err=%v", transfers, err)
	}
	if transfers[0].Actor != "alice" || transfers[0].Target != projectID || transfers[0].Result != "success" || transfers[0].Metadata["to_username"] != "bob" || transfers[0].Metadata["transfer_id"] == "" {
		t.Fatalf("unexpected transfer event: %#v", transfers[0])
	}

	if removed := collaborationRequest(t, handler, bob.session, http.MethodDelete, "/api/portal/shared-projects/"+projectID+"/members/"+strconv.FormatInt(alice.user.ID, 10), ""); removed.Code != http.StatusNoContent {
		t.Fatalf("remove = %d %s", removed.Code, removed.Body.String())
	}
	revokes, err := auditStore.List(t.Context(), contracts.AuditQuery{Action: audit.ActionCollaborationACLRevoke})
	if err != nil || len(revokes) != 1 {
		t.Fatalf("revokes=%#v err=%v", revokes, err)
	}
	if revokes[0].Actor != "bob" || revokes[0].Target != projectID || revokes[0].Metadata["member_sid"] != alice.user.SID {
		t.Fatalf("unexpected revoke event: %#v", revokes[0])
	}
}
