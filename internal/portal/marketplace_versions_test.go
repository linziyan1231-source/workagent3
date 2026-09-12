package portal

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"workagent3/internal/marketplace"
	"workagent3/internal/runtimeapi"
)

func TestProjectSubscriptionsAndExplicitMarketUpdate(t *testing.T) {
	market, err := marketplace.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer market.Close()
	var server *Server
	handler, _, _, alice, bob := collaborationTestServer(t, func(s *Server) { server = s; s.modules.Marketplace = market })
	old := marketplace.Entry{ID: "old-version-001", Name: "Review", Kind: "skill", Version: "1.0.0", Publisher: "alice"}
	newer := marketplace.Entry{ID: "new-version-002", Name: "Review", Kind: "skill", Version: "2.0.0", Publisher: "alice", ReleaseNotes: "修复规则"}
	for _, e := range []marketplace.Entry{old, newer} {
		if err = market.Publish(t.Context(), e, marketplace.Bundle{Skills: []marketplace.Skill{{ID: "source", Name: "Review", Version: e.Version}}, MCP: []marketplace.Connector{}}); err != nil {
			t.Fatal(err)
		}
	}
	old, _, _ = market.Get(t.Context(), old.ID)
	newer, _, _ = market.Get(t.Context(), newer.ID)
	busy := true
	changes := []marketChange{}
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/workspaces":
			writeJSON(w, 200, []map[string]string{{"id": "personal-project", "name": "Private project"}})
		case "GET /v1/skills":
			writeJSON(w, 200, []map[string]any{{"id": "installed-old", "name": "Review old"}, {"id": "installed-new", "name": "Review new"}})
		case "GET /v1/mcp-servers", "GET /v1/presets":
			writeJSON(w, 200, []any{})
		case "POST /v1/market-capabilities/change":
			if busy {
				writeError(w, 409, "market_update_session_busy")
				return
			}
			var change marketChange
			json.NewDecoder(r.Body).Decode(&change)
			changes = append(changes, change)
			writeJSON(w, 200, map[string]bool{"applied": true})
		default:
			t.Errorf("unexpected runtime mutation %s %s", r.Method, r.URL.Path)
			writeError(w, 404, "not_found")
		}
	}))
	defer runtime.Close()
	base, _ := url.Parse(runtime.URL)
	server.runtimes = StaticRouter{alice.user.SID: runtimeapi.Endpoint{BaseURL: base, Token: "runtime-token"}}
	for _, row := range []struct{ id, target string }{{old.ID, "installed-old"}, {newer.ID, "installed-new"}} {
		if err = market.SaveInstallation(t.Context(), alice.user.SID, row.id, marketplace.Installation{Skills: map[string]string{"source": row.target}, MCP: map[string]string{}, Complete: true}); err != nil {
			t.Fatal(err)
		}
	}
	created := collaborationRequest(t, handler, alice.session, "POST", "/api/portal/shared-projects", `{"name":"Design"}`)
	var project struct {
		Project sharedProjectDTO `json:"project"`
	}
	if json.Unmarshal(created.Body.Bytes(), &project) != nil || created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	path := "/api/portal/shared-projects/" + project.Project.ID + "/capabilities"
	call := func(session, method, path, body string) *httptest.ResponseRecorder {
		return collaborationRequest(t, handler, session, method, path, body)
	}
	if r := call(alice.session, "POST", path, `{"id":"`+old.ID+`"}`); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if _, _, err = market.Selection(t.Context(), alice.user.SID, old.SeriesID); !errors.Is(err, marketplace.ErrNotFound) {
		t.Fatal("project subscription changed personal selection")
	}
	if r := call(bob.session, "POST", path, `{"id":"`+newer.ID+`"}`); r.Code < 400 {
		t.Fatal("nonmember changed subscription")
	}
	if r := call(alice.session, "POST", "/api/portal/projects/personal-project/capabilities", `{"id":"`+newer.ID+`"}`); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	personalPins, _ := market.Subscriptions(t.Context(), personalSubscriptionKey(alice.user.SID, "personal-project"))
	if len(personalPins) != 1 || personalPins[0].EntryID != newer.ID {
		t.Fatal("personal project subscription missing", personalPins)
	}
	if pins, _ := market.Subscriptions(t.Context(), personalSubscriptionKey(bob.user.SID, "personal-project")); len(pins) != 0 {
		t.Fatal("personal subscription leaked to other employee")
	}
	if r := call(alice.session, "POST", "/api/portal/projects/missing-project/capabilities", `{"id":"`+newer.ID+`"}`); r.Code != 404 {
		t.Fatal("unknown personal project accepted")
	}
	market.Select(t.Context(), alice.user.SID, old)
	r := call(alice.session, "POST", "/api/portal/marketplace/update", `{"all":true}`)
	if !strings.Contains(r.Body.String(), "market_update_session_busy") {
		t.Fatal(r.Body.String())
	}
	if e, _, _ := market.Selection(t.Context(), alice.user.SID, old.SeriesID); e.ID != old.ID {
		t.Fatal("failed update changed selection")
	}
	busy = false
	r = call(alice.session, "POST", "/api/portal/marketplace/update", `{"all":true}`)
	if !strings.Contains(r.Body.String(), `"success":true`) || len(changes) != 1 || changes[0].Skills["installed-old"] != "installed-new" {
		t.Fatal(r.Body.String(), changes)
	}
	pins, _ := market.Subscriptions(t.Context(), project.Project.ID)
	if len(pins) != 1 || pins[0].EntryID != old.ID {
		t.Fatal("personal update changed project version")
	}
	cap, err := server.resolveProjectCapabilities(t.Context(), project.Project.ID, alice.user)
	if err != nil || len(cap.SkillIDs) != 1 || cap.SkillIDs[0] != "installed-old" {
		t.Fatal(cap, err)
	}
	if r := call(alice.session, "POST", path, `{"id":"`+newer.ID+`"}`); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	if r := call(alice.session, "GET", "/api/portal/marketplace/versions?seriesId="+old.SeriesID, ""); !strings.Contains(r.Body.String(), "修复规则") {
		t.Fatal("version notes missing")
	}
	if r := call(alice.session, "POST", "/api/portal/admin/marketplace", `{"action":"delete","seriesId":"`+old.SeriesID+`","reason":"security"}`); r.Code != 403 {
		t.Fatal("non-admin governance allowed", r.Code)
	}
}

func TestMarketRuntimeAdmissionAuthenticatesEmployee(t *testing.T) {
	market, _ := marketplace.Open(":memory:")
	defer market.Close()
	var server *Server
	_, _, _, alice, bob := collaborationTestServer(t, func(s *Server) { server = s; s.modules.Marketplace = market })
	server.store.AuthorizeRuntime(t.Context(), alice.user.SID, "runtime-registration-token")
	call := func(sid, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1/internal/runtime/market-capabilities", strings.NewReader(`{"sid":"`+sid+`"}`))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		server.MarketRuntimeHandler().ServeHTTP(w, r)
		return w
	}
	if r := call(bob.user.SID, "runtime-registration-token"); r.Code != 401 {
		t.Fatal("cross-employee admission accepted")
	}
	if r := call(alice.user.SID, "runtime-registration-token"); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
}
