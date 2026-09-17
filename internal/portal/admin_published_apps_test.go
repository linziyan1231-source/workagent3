package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"workagent3/internal/publishedapps"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func publishedAppSettingsFixture(t *testing.T) (*Server, *publishedapps.Store, publishedapps.App) {
	t.Helper()
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	admin, err := data.CreateUser(t.Context(), "manager", "S-1-5-21-9000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err = data.SetUserAdmin(t.Context(), admin.Username, true); err != nil {
		t.Fatal(err)
	}
	if err = data.CreateSession(t.Context(), "admin-session", admin.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	member, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err = data.CreateSession(t.Context(), "user-session", member.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	apps, err := publishedapps.Open(filepath.Join(t.TempDir(), "apps.db"), 25000, 25009, 3)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { apps.Close() })
	a, err := apps.Create(t.Context(), publishedapps.App{OwnerSID: member.SID, OwnerID: member.ID, WorkspaceID: "default", Name: "site", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{EmployeeManagement: &fakeEmployeeManagement{}, PublishedApps: PublishedAppsConfig{Store: apps, PublicURL: "http://192.0.2.1:8080"}})
	if err != nil {
		t.Fatal(err)
	}
	return server, apps, a
}

func settingsRequest(handler http.Handler, method, body, session string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, "http://portal.test/api/portal/admin/published-apps/settings", reader)
	if method != http.MethodGet {
		r.Header.Set("Origin", "http://portal.test")
	}
	if session != "" {
		r.AddCookie(&http.Cookie{Name: "workagent-session", Value: session})
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestAdminPublishedAppSettingsAccessAndUpdate(t *testing.T) {
	server, apps, a := publishedAppSettingsFixture(t)
	handler := server.Handler()
	if w := settingsRequest(handler, http.MethodGet, "", ""); w.Code != http.StatusUnauthorized {
		t.Fatal("anonymous", w.Code)
	}
	if w := settingsRequest(handler, http.MethodGet, "", "user-session"); w.Code != http.StatusForbidden {
		t.Fatal("member", w.Code)
	}
	w := settingsRequest(handler, http.MethodGet, "", "admin-session")
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	var state struct {
		FirstPort        int `json:"firstPort"`
		LastPort         int `json:"lastPort"`
		MaxEmployeePorts int `json:"maxEmployeePorts"`
		TotalPorts       int `json:"totalPorts"`
		UsedPorts        int `json:"usedPorts"`
		EmployeeUsage    []struct {
			SID      string `json:"sid"`
			Username string `json:"username"`
			Ports    int    `json:"ports"`
		} `json:"employeeUsage"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.FirstPort != 25000 || state.LastPort != 25009 || state.MaxEmployeePorts != 3 || state.TotalPorts != 10 || state.UsedPorts != 2 {
		t.Fatal(state)
	}
	if len(state.EmployeeUsage) != 1 || state.EmployeeUsage[0].Username != "alice" || state.EmployeeUsage[0].Ports != 1 {
		t.Fatal(state.EmployeeUsage)
	}
	// Invalid range rejected.
	if w = settingsRequest(handler, http.MethodPut, `{"firstPort":80,"lastPort":25009,"maxEmployeePorts":3}`, "admin-session"); w.Code != http.StatusBadRequest {
		t.Fatal("low port accepted", w.Code)
	}
	// A second app makes the undersized range check meaningful.
	if _, err := apps.Create(t.Context(), publishedapps.App{OwnerSID: "S-1-5-21-1000", OwnerID: 2, WorkspaceID: "default", Name: "second", Kind: "static", Entry: "index.html"}); err != nil {
		t.Fatal(err)
	}
	// Three ports are a valid range but cannot hold two apps (2 ports each).
	if w = settingsRequest(handler, http.MethodPut, `{"firstPort":25100,"lastPort":25102,"maxEmployeePorts":3}`, "admin-session"); w.Code != http.StatusUnprocessableEntity {
		t.Fatal("undersized range accepted", w.Code)
	}
	// Valid update remaps the existing app and persists the quota.
	w = settingsRequest(handler, http.MethodPut, `{"firstPort":25100,"lastPort":25109,"maxEmployeePorts":4}`, "admin-session")
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	saved, err := apps.Get(t.Context(), a.ID)
	if err != nil || saved.Port != 25100 || saved.PreviewPort != 25101 {
		t.Fatal(saved.Port, saved.PreviewPort, err)
	}
	first, last, max := apps.Settings()
	if first != 25100 || last != 25109 || max != 4 {
		t.Fatal(first, last, max)
	}
}

func adminAppsRequest(handler http.Handler, method, path, session string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://portal.test"+path, nil)
	if method != http.MethodGet {
		r.Header.Set("Origin", "http://portal.test")
	}
	if session != "" {
		r.AddCookie(&http.Cookie{Name: "workagent-session", Value: session})
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestAdminPublishedAppsListAccessAndContent(t *testing.T) {
	server, apps, a := publishedAppSettingsFixture(t)
	handler := server.Handler()
	a.Enabled = true
	a.Access = publishedapps.AccessToken
	a.ShareToken = "tok123"
	a.Version = "v1"
	if _, err := apps.Update(t.Context(), a, a.Revision); err != nil {
		t.Fatal(err)
	}
	// A second app owned by the admin proves the listing is not owner-scoped.
	admin, err := server.store.UserByUsername(t.Context(), "manager")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = apps.Create(t.Context(), publishedapps.App{OwnerSID: admin.SID, OwnerID: admin.ID, WorkspaceID: "default", Name: "admin-site", Kind: "static", Entry: "index.html"}); err != nil {
		t.Fatal(err)
	}
	if w := adminAppsRequest(handler, http.MethodGet, "/api/portal/admin/published-apps", ""); w.Code != http.StatusUnauthorized {
		t.Fatal("anonymous", w.Code)
	}
	if w := adminAppsRequest(handler, http.MethodGet, "/api/portal/admin/published-apps", "user-session"); w.Code != http.StatusForbidden {
		t.Fatal("member", w.Code)
	}
	w := adminAppsRequest(handler, http.MethodGet, "/api/portal/admin/published-apps", "admin-session")
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	var body struct {
		Apps []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			Username  string `json:"username"`
			ShareURL  string `json:"shareUrl"`
			Enabled   bool   `json:"enabled"`
			CreatedAt string `json:"createdAt"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Apps) != 2 {
		t.Fatal(body.Apps)
	}
	byName := map[string]int{}
	for i, entry := range body.Apps {
		byName[entry.Name] = i
		if entry.CreatedAt == "" {
			t.Fatal("missing createdAt", entry)
		}
	}
	alice, ok := byName["site"]
	if !ok || body.Apps[alice].Username != "alice" || !body.Apps[alice].Enabled {
		t.Fatal(body.Apps)
	}
	if !strings.Contains(body.Apps[alice].ShareURL, "/t/tok123/") {
		t.Fatal("share link", body.Apps[alice].ShareURL)
	}
	own, ok := byName["admin-site"]
	if !ok || body.Apps[own].Username != "manager" {
		t.Fatal(body.Apps)
	}
}

func TestAdminUnpublishPublishedApp(t *testing.T) {
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{}`))
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	server, apps, a := publishedAppSettingsFixture(t)
	// Route the owner's runtime to the downstream stub so the stop succeeds.
	server.runtimes = StaticRouter{a.OwnerSID: runtimeapi.Endpoint{BaseURL: target, Token: "internal"}}
	handler := server.Handler()
	a.Enabled = true
	a.Access = publishedapps.AccessPublic
	a.Version = "v1"
	a.PreviewVersion = "preview"
	if _, err := apps.Update(t.Context(), a, a.Revision); err != nil {
		t.Fatal(err)
	}
	path := "/api/portal/admin/published-apps/" + a.ID + "/unpublish"
	if w := adminAppsRequest(handler, http.MethodPost, path, "user-session"); w.Code != http.StatusForbidden {
		t.Fatal("member", w.Code)
	}
	if w := adminAppsRequest(handler, http.MethodPost, "/api/portal/admin/published-apps/missing/unpublish", "admin-session"); w.Code != http.StatusNotFound {
		t.Fatal("unknown app", w.Code)
	}
	w := adminAppsRequest(handler, http.MethodPost, path, "admin-session")
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	updated, err := apps.Get(t.Context(), a.ID)
	if err != nil || updated.Enabled || updated.PreviewVersion != "" {
		t.Fatal("app still published", updated.Enabled, err)
	}
}
