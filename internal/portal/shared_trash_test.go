package portal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
)

type sharedTrashFixture struct {
	entries map[string]map[string]string
	calls   []contracts.SharedTrashRequest
	project string
}

func (f *sharedTrashFixture) OperateSharedTrash(_ context.Context, projectID string, input contracts.SharedTrashRequest) (json.RawMessage, error) {
	f.calls = append(f.calls, input)
	f.project = projectID
	if input.Operation == "recycle" {
		return json.RawMessage(`{"id":"recycled-entry"}`), nil
	}
	if input.Operation == "list" {
		entries := []map[string]string{}
		for id, name := range f.entries[projectID] {
			entries = append(entries, map[string]string{"id": id, "name": name})
		}
		result, _ := json.Marshal(map[string]any{"entries": entries, "usedBytes": 100, "limitBytes": 60 * 1024 * 1024 * 1024, "retentionDays": 7})
		return result, nil
	}
	if f.entries[projectID][input.EntryID] == "" {
		return nil, &sharedTrashResponseError{status: 404, code: "trash_entry_not_found"}
	}
	delete(f.entries[projectID], input.EntryID)
	return json.RawMessage(`{}`), nil
}

func newTrashTestProject(t *testing.T, handler http.Handler, session, name string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name})
	w := collaborationRequest(t, handler, session, "POST", "/api/portal/shared-projects", string(body))
	var result struct {
		Project sharedProjectDTO `json:"project"`
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatalf("create project: %d %s", w.Code, w.Body.String())
	}
	return result.Project.ID
}

func joinTrashTestProject(t *testing.T, handler http.Handler, owner, member, project string) {
	t.Helper()
	w := collaborationRequest(t, handler, owner, "POST", "/api/portal/shared-projects/"+project+"/invites", `{"targetUsername":"bob","expiresInHours":24}`)
	var result struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatalf("invite member: %d %s", w.Code, w.Body.String())
	}
	w = collaborationRequest(t, handler, member, "POST", "/api/portal/shared-invites/"+result.Invite.ID+"/accept", `{}`)
	if w.Code != 200 {
		t.Fatalf("join member: %d %s", w.Code, w.Body.String())
	}
}

func TestSharedTrashBrowserChecksProjectMembershipOnEveryOperation(t *testing.T) {
	trash := &sharedTrashFixture{entries: map[string]map[string]string{}}
	handler, _, _, alice, bob := collaborationTestServer(t, func(s *Server) { s.modules.SharedTrash = trash })
	a := newTrashTestProject(t, handler, alice.session, "Alice project")
	b := newTrashTestProject(t, handler, bob.session, "Bob project")
	trash.entries[a] = map[string]string{"entry-a": "alice-plan.txt"}
	trash.entries[b] = map[string]string{"entry-b": "bob-private-project.txt"}
	base := "/api/portal/shared-workspaces/" + a + "/trash"
	w := collaborationRequest(t, handler, alice.session, "GET", base+"?ownerSID="+bob.user.SID, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "alice-plan.txt") || strings.Contains(w.Body.String(), "bob-private-project") {
		t.Fatalf("project list isolation: %d %s", w.Code, w.Body.String())
	}
	if trash.calls[0].OwnerSID != alice.user.SID || trash.project != a {
		t.Fatal("client owner SID overrode the authorized project owner")
	}
	w = collaborationRequest(t, handler, alice.session, "GET", "/api/portal/shared-workspaces/"+b+"/trash", "")
	if w.Code != 404 || len(trash.calls) != 1 {
		t.Fatal("nonmember read reached the privileged store")
	}
	for _, operation := range []struct{ method, path string }{{"POST", "/entry-b/restore"}, {"DELETE", "/entry-b"}} {
		w = collaborationRequest(t, handler, alice.session, operation.method, base+operation.path, "")
		if w.Code != 404 || trash.entries[b]["entry-b"] == "" {
			t.Fatal("cross-project entry ID accepted", w.Code)
		}
	}
	joinTrashTestProject(t, handler, alice.session, bob.session, a)
	w = collaborationRequest(t, handler, bob.session, "GET", base, "")
	if w.Code != 200 || trash.calls[len(trash.calls)-1].OwnerSID != alice.user.SID {
		t.Fatal("current member cannot access the project trash")
	}
	w = collaborationRequest(t, handler, alice.session, "DELETE", "/api/portal/shared-projects/"+a+"/members/"+strconv.FormatInt(bob.user.ID, 10), "")
	if w.Code != 204 {
		t.Fatalf("remove member: %d %s", w.Code, w.Body.String())
	}
	calls := len(trash.calls)
	for _, operation := range []struct{ method, path string }{{"GET", ""}, {"POST", "/entry-a/restore"}, {"DELETE", "/entry-a"}} {
		w = collaborationRequest(t, handler, bob.session, operation.method, base+operation.path, "")
		if w.Code != 404 || len(trash.calls) != calls {
			t.Fatal("removed member retained access", operation.method, w.Code)
		}
	}
	w = collaborationRequest(t, handler, alice.session, "POST", base+"/entry-a/restore", "")
	if w.Code != 200 || trash.entries[a]["entry-a"] != "" {
		t.Fatal("authorized restoration failed", w.Code)
	}
}

func TestSharedTrashRuntimeBindsCredentialAndCurrentMembership(t *testing.T) {
	trash := &sharedTrashFixture{entries: map[string]map[string]string{}}
	var server *Server
	handler, _, _, alice, bob := collaborationTestServer(t, func(s *Server) { server = s; s.modules.SharedTrash = trash })
	a := newTrashTestProject(t, handler, alice.session, "Shared files")
	trash.entries[a] = map[string]string{"entry-a": "private.txt"}
	server.store.AuthorizeRuntime(t.Context(), alice.user.SID, "alice-runtime-token")
	server.store.AuthorizeRuntime(t.Context(), bob.user.SID, "bob-runtime-token")
	call := func(sid, token, address string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"sid": sid, "projectId": a, "operation": "list"})
		r := httptest.NewRequest("POST", "http://127.0.0.1/internal/runtime/shared-trash", strings.NewReader(string(body)))
		r.RemoteAddr = address
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		server.SharedTrashRuntimeHandler().ServeHTTP(w, r)
		return w
	}
	if w := call(bob.user.SID, "alice-runtime-token", "127.0.0.1:1234"); w.Code != 401 {
		t.Fatal("cross-employee credential accepted", w.Code)
	}
	if w := call(alice.user.SID, "alice-runtime-token", "192.0.2.1:1234"); w.Code != 403 {
		t.Fatal("non-loopback caller accepted", w.Code)
	}
	if w := call(bob.user.SID, "bob-runtime-token", "127.0.0.1:1234"); w.Code != 404 {
		t.Fatal("valid employee credential bypassed project membership", w.Code)
	}
	if w := call(alice.user.SID, "alice-runtime-token", "127.0.0.1:1234"); w.Code != 200 {
		t.Fatal("authorized runtime rejected", w.Body.String())
	}
	joinTrashTestProject(t, handler, alice.session, bob.session, a)
	if w := call(bob.user.SID, "bob-runtime-token", "127.0.0.1:1234"); w.Code != 200 {
		t.Fatal("authorized member runtime rejected", w.Body.String())
	}
	if len(trash.calls) != 2 || trash.calls[1].OwnerSID != alice.user.SID {
		t.Fatal("runtime request did not use current project ownership")
	}
	collaborationRequest(t, handler, alice.session, "DELETE", "/api/portal/shared-projects/"+a+"/members/"+strconv.FormatInt(bob.user.ID, 10), "")
	if w := call(bob.user.SID, "bob-runtime-token", "127.0.0.1:1234"); w.Code != 404 || len(trash.calls) != 2 {
		t.Fatal("removed runtime member retained access", w.Code)
	}
}

func TestSharedTrashManagerClientPreservesConflictWithoutExposingCredentials(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/shared-trash/project_1234567890" || r.Header.Get("Authorization") != "Bearer manager-test-token" || r.Header.Get("Cookie") != "" {
			t.Fatal("incorrect protected manager request")
		}
		var input contracts.SharedTrashRequest
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.OwnerSID != "S-1-5-21-1000" || input.EntryID != "entry-id" {
			t.Fatal("manager request lost project context")
		}
		writeError(w, 409, "file_exists")
	}))
	defer upstream.Close()
	client, err := NewEmployeeManagerClient(upstream.URL, "manager-test-token")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{modules: Modules{SharedTrash: client}}
	w := httptest.NewRecorder()
	server.operateSharedTrash(w, httptest.NewRequest("POST", "/", nil), "project_1234567890", contracts.SharedTrashRequest{OwnerSID: "S-1-5-21-1000", Operation: "restore", EntryID: "entry-id"})
	if w.Code != 409 || strings.TrimSpace(w.Body.String()) != `{"error":"file_exists"}` {
		t.Fatalf("restore conflict was lost: %d %s", w.Code, w.Body.String())
	}
}

func TestSharedTrashControlledRecyclePassesOwnerWorkspaceStore(t *testing.T) {
	trash := &sharedTrashFixture{entries: map[string]map[string]string{}}
	var server *Server
	handler, _, _, alice, bob := collaborationTestServer(t, func(s *Server) { server = s; s.modules.SharedTrash = trash })
	project := newTrashTestProject(t, handler, alice.session, "Controlled deletion")
	joinTrashTestProject(t, handler, alice.session, bob.session, project)
	server.store.AuthorizeRuntime(t.Context(), alice.user.SID, "owner-platform-token")
	server.store.AuthorizeRuntime(t.Context(), bob.user.SID, "member-platform-token")
	call := func(sid, token, operation, path, source string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"sid": sid, "projectId": project, "operation": operation, "path": path, "source": source})
		r := httptest.NewRequest("POST", "http://127.0.0.1/internal/runtime/shared-trash", strings.NewReader(string(body)))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Cookie", "must-not-be-forwarded")
		w := httptest.NewRecorder()
		server.SharedTrashRuntimeHandler().ServeHTTP(w, r)
		return w
	}
	forwarded := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded++
		if r.Method != "DELETE" || r.URL.Path != "/v1/shared-workspaces/"+project+"/content" || r.URL.Query().Get("path") != "drafts/中文 plan.txt" {
			t.Error("controlled deletion lost the owner's workspace or original path")
		}
		if r.Header.Get("Authorization") != "Bearer owner-runtime-token" || r.Header.Get("Cookie") != "" {
			t.Error("controlled deletion forwarded employee or browser credentials")
		}
		callback := call(alice.user.SID, "owner-platform-token", "recycle", r.URL.Query().Get("path"), "workspace-store")
		if callback.Code != 200 {
			t.Errorf("owner Store callback failed: %d %s", callback.Code, callback.Body.String())
			w.WriteHeader(502)
			return
		}
		w.WriteHeader(204)
	}))
	defer upstream.Close()
	endpoint, _ := url.Parse(upstream.URL)
	server.runtimes = StaticRouter{alice.user.SID: runtimeapi.Endpoint{BaseURL: endpoint, Token: "owner-runtime-token"}}
	for _, source := range []string{"workspace-store", "unrecognized"} {
		if w := call(bob.user.SID, "member-platform-token", "recycle", "drafts/中文 plan.txt", source); w.Code != 403 {
			t.Fatal("member bypassed workspace identity bookkeeping", w.Code)
		}
	}
	if len(trash.calls) != 0 || forwarded != 0 {
		t.Fatal("rejected source marker reached storage")
	}
	for _, path := range []string{"drafts/中文 plan.txt", "shared://" + project + "/drafts/中文 plan.txt"} {
		if w := call(bob.user.SID, "member-platform-token", "recycle", path, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"recycled":true`) {
			t.Fatalf("controlled recycle failed: %d %s", w.Code, w.Body.String())
		}
	}
	if forwarded != 2 || len(trash.calls) != 2 || trash.calls[1].OwnerSID != alice.user.SID || trash.calls[1].Path != "drafts/中文 plan.txt" {
		t.Fatal("controlled deletion did not pass exactly once through owner Store and central pool")
	}
}
