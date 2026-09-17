package portal

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"workagent3/internal/collaboration"
	"workagent3/internal/publishedapps"
	"workagent3/internal/store"
)

func TestSharedApplicationStopsWhenProjectArchived(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(t.Context(), "owner", "S-1-5-21-1000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	shared, err := collaboration.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer shared.Close()
	project, err := shared.CreateProject(t.Context(), collaboration.Project{ID: "shared_project_123456", OwnerUserID: user.ID, OwnerSID: user.SID, Name: "Shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err = shared.SetProvisioningResult(t.Context(), project.ID, true); err != nil {
		t.Fatal(err)
	}
	server := &Server{store: data, modules: Modules{Collaboration: shared}}
	app := publishedapps.App{OwnerSID: user.SID, OwnerID: user.ID, WorkspaceID: "shared:" + project.ID}
	if !server.applicationOwnerAllowed(t.Context(), app) {
		t.Fatal("current owner rejected")
	}
	if err = shared.ArchiveProject(t.Context(), project.ID, user.ID); err != nil {
		t.Fatal(err)
	}
	if server.applicationOwnerAllowed(t.Context(), app) {
		t.Fatal("archived shared app still available")
	}
}

func TestApplicationPrivateTicketSingleUseAndRevisionRevocation(t *testing.T) {
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("private")) }))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(t.Context(), "owner", "S-1-5-21-1000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	apps, err := publishedapps.Open(filepath.Join(t.TempDir(), "apps.db"), 22000, 22009, publishedapps.DefaultMaxEmployeePorts)
	if err != nil {
		t.Fatal(err)
	}
	defer apps.Close()
	app, err := apps.Create(t.Context(), publishedapps.App{OwnerSID: user.SID, OwnerID: user.ID, WorkspaceID: "default", Name: "private", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	app.Enabled = true
	app.Version = "one"
	app, err = apps.Update(t.Context(), app, app.Revision)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(data, StaticRouter{user.SID: {BaseURL: target, Token: "internal"}}, false, Modules{PublishedApps: PublishedAppsConfig{Store: apps, PublicURL: "http://192.0.2.1:8080"}})
	if err != nil {
		t.Fatal(err)
	}
	gateway := server.apps
	origin := "http://192.0.2.1:" + strconv.Itoa(app.Port)
	get := func(cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", origin+"/data", nil)
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		gateway.handler(app.ID, false).ServeHTTP(w, r)
		return w
	}
	if w := get(nil); w.Code != 403 {
		t.Fatal("anonymous private access", w.Code)
	}
	gateway.tickets["one-use"] = appGrant{AppID: app.ID, SID: user.SID, UserID: user.ID, Revision: app.Revision, Expires: time.Now().Add(time.Minute)}
	exchange := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", origin+"/__workagent/access", strings.NewReader("ticket=one-use"))
		r.Header.Set("Origin", "http://192.0.2.1:8080")
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		gateway.handler(app.ID, false).ServeHTTP(w, r)
		return w
	}
	w := exchange()
	if w.Code != 303 {
		t.Fatalf("exchange %d %s", w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly {
		t.Fatal("missing private grant")
	}
	if w = exchange(); w.Code != 403 {
		t.Fatal("ticket reused", w.Code)
	}
	if w = get(cookies[0]); w.Code != 200 {
		t.Fatal("grant rejected", w.Code, w.Body.String())
	}
	app.Enabled = false
	if _, err = apps.Update(t.Context(), app, app.Revision); err != nil {
		t.Fatal(err)
	}
	if w = get(cookies[0]); w.Code != 403 {
		t.Fatal("revoked grant accepted", w.Code)
	}
}

func TestEmployeeRuntimeProxyRejectsPrivateAdministrationPaths(t *testing.T) {
	server := &Server{}
	for _, path := range []string{"/api/runtime/internal/acp-catalog", "/api/runtime/v1/published-apps/id/versions", "/api/runtime/%69nternal/acp-catalog"} {
		request := httptest.NewRequest("POST", path, nil)
		writer := httptest.NewRecorder()
		server.proxyRuntimePath(writer, request, store.User{}, "/api/runtime/")
		if writer.Code != 403 {
			t.Errorf("%s: %d", path, writer.Code)
		}
	}
}
