package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"workagent3/internal/publishedapps"
	"workagent3/internal/store"
)

func newShareTestServer(t *testing.T, access string) (*Server, *publishedapps.Store, publishedapps.App, store.User, string) {
	t.Helper()
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("private")) }))
	t.Cleanup(downstream.Close)
	target, _ := url.Parse(downstream.URL)
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	user, err := data.CreateUser(t.Context(), "owner", "S-1-5-21-1000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	apps, err := publishedapps.Open(filepath.Join(t.TempDir(), "apps.db"), 24300, 24309)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { apps.Close() })
	app, err := apps.Create(t.Context(), publishedapps.App{OwnerSID: user.SID, OwnerID: user.ID, WorkspaceID: "default", Name: "site", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	app.Enabled = true
	app.Version = "one"
	app.Access = access
	app.ShareToken = "share-token-x"
	app.Password = "12345678"
	app.ExpiresAt = time.Now().Add(5 * 24 * time.Hour)
	app, err = apps.Update(t.Context(), app, app.Revision)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(data, StaticRouter{user.SID: {BaseURL: target, Token: "internal"}}, false, Modules{PublishedApps: PublishedAppsConfig{Store: apps, PublicURL: "http://192.0.2.1:8080"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.ClosePublishedApps)
	return server, apps, app, user, "http://192.0.2.1:" + strconv.Itoa(app.Port)
}

func TestShareTokenGrantsAnonymousAccessUntilExpiry(t *testing.T) {
	server, apps, app, _, origin := newShareTestServer(t, publishedapps.AccessToken)
	gateway := server.apps
	get := func(path string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", origin+path, nil)
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		gateway.handler(app.ID, false).ServeHTTP(w, r)
		return w
	}
	if w := get("/t/wrong-token/", nil); w.Code != 403 {
		t.Fatal("bad share token", w.Code)
	}
	w := get("/t/share-token-x/", nil)
	if w.Code != 303 {
		t.Fatalf("share token exchange %d %s", w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly {
		t.Fatal("missing anonymous grant cookie")
	}
	if w = get("/", cookies[0]); w.Code != 200 {
		t.Fatal("anonymous grant rejected", w.Code, w.Body.String())
	}
	current, err := apps.Get(t.Context(), app.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.ExpiresAt = time.Now().Add(-time.Hour)
	if _, err = apps.Update(t.Context(), current, current.Revision); err != nil {
		t.Fatal(err)
	}
	if w = get("/", cookies[0]); w.Code != 303 || !strings.Contains(w.Header().Get("Location"), "/apps/") {
		t.Fatal("expired app still serves", w.Code, w.Header().Get("Location"))
	}
	if w = get("/t/share-token-x/", nil); w.Code != 403 {
		t.Fatal("expired share token accepted", w.Code)
	}
}

func TestPasswordEndpointExchangesAnonymousTicket(t *testing.T) {
	server, _, app, _, origin := newShareTestServer(t, publishedapps.AccessPassword)
	landing := httptest.NewRecorder()
	server.Handler().ServeHTTP(landing, httptest.NewRequest("GET", "/apps/"+app.ID, nil))
	if !strings.Contains(landing.Body.String(), "password") {
		t.Fatal("password landing missing form", landing.Body.String())
	}
	post := func(password string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/portal/apps/"+app.ID+"/password", strings.NewReader("password="+password))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", "http://example.com")
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		return w
	}
	if w := post("00000000"); w.Code != 403 {
		t.Fatal("wrong password accepted", w.Code)
	}
	w := post("12345678")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "/__workagent/access") {
		t.Fatalf("password exchange %d %s", w.Code, w.Body.String())
	}
	// Extract the ticket from the rendered exchange form and redeem it.
	body := w.Body.String()
	marker := `name="ticket" value="`
	ticket := body[strings.Index(body, marker)+len(marker):]
	ticket = ticket[:strings.Index(ticket, `"`)]
	r := httptest.NewRequest("POST", origin+"/__workagent/access", strings.NewReader("ticket="+ticket))
	r.Header.Set("Origin", "http://192.0.2.1:8080")
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	exchange := httptest.NewRecorder()
	server.apps.handler(app.ID, false).ServeHTTP(exchange, r)
	if exchange.Code != 303 {
		t.Fatalf("ticket exchange %d %s", exchange.Code, exchange.Body.String())
	}
	cookie := exchange.Result().Cookies()[0]
	get := httptest.NewRecorder()
	gr := httptest.NewRequest("GET", origin+"/", nil)
	gr.AddCookie(cookie)
	server.apps.handler(app.ID, false).ServeHTTP(get, gr)
	if get.Code != 200 {
		t.Fatal("password grant rejected", get.Code)
	}
	for range 10 {
		post("00000000")
	}
	if w = post("12345678"); w.Code != 429 {
		t.Fatal("password attempts not limited", w.Code)
	}
}

func TestExpiredApplicationLandingAndEnable(t *testing.T) {
	server, apps, app, user, _ := newShareTestServer(t, publishedapps.AccessAuthenticated)
	current, err := apps.Get(t.Context(), app.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.ExpiresAt = time.Now().Add(-time.Hour)
	if _, err = apps.Update(t.Context(), current, current.Revision); err != nil {
		t.Fatal(err)
	}
	landing := httptest.NewRecorder()
	server.Handler().ServeHTTP(landing, httptest.NewRequest("GET", "/apps/"+app.ID, nil))
	if !strings.Contains(landing.Body.String(), "有效期") {
		t.Fatal("expired landing missing message", landing.Body.String())
	}
	call := func(action string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/portal/apps/"+app.ID+"/"+action, nil)
		r.SetPathValue("id", app.ID)
		r.SetPathValue("action", action)
		w := httptest.NewRecorder()
		server.publishedAppsHTTP(w, r, user)
		return w
	}
	if w := call("enable"); w.Code != 200 {
		t.Fatalf("enable %d %s", w.Code, w.Body.String())
	}
	updated, err := apps.Get(t.Context(), app.ID)
	if err != nil || !updated.Enabled || updated.Expired(time.Now()) {
		t.Fatalf("enable did not renew: %#v %v", updated, err)
	}
	if w := call("delete"); w.Code != 200 {
		t.Fatalf("delete %d %s", w.Code, w.Body.String())
	}
	if _, err = apps.Get(t.Context(), app.ID); err == nil {
		t.Fatal("deleted app still visible")
	}
	if w := call("delete"); w.Code != 404 {
		t.Fatal("deleted app deletes again", w.Code)
	}
}

func TestRuntimePublishEndpointCreatesAndReusesApps(t *testing.T) {
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{}")) }))
	t.Cleanup(downstream.Close)
	target, _ := url.Parse(downstream.URL)
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	user, err := data.CreateUser(t.Context(), "owner", "S-1-5-21-1000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err = data.AuthorizeRuntime(t.Context(), user.SID, "registration-secret"); err != nil {
		t.Fatal(err)
	}
	apps, err := publishedapps.Open(filepath.Join(t.TempDir(), "apps.db"), 24320, 24329)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { apps.Close() })
	server, err := NewWithModules(data, StaticRouter{user.SID: {BaseURL: target, Token: "internal"}}, false, Modules{PublishedApps: PublishedAppsConfig{Store: apps, PublicURL: "http://192.0.2.1:8080"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.ClosePublishedApps)
	call := func(body, credential string, loopback bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/internal/runtime/published-apps/publish", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:5000"
		if !loopback {
			r.RemoteAddr = "192.0.2.99:5000"
		}
		r.Header.Set("Authorization", "Bearer "+credential)
		w := httptest.NewRecorder()
		server.PublishedAppsRuntimeHandler().ServeHTTP(w, r)
		return w
	}
	if w := call(`{"sid":"S-1-5-21-1000","workspaceId":"default","name":"站点"}`, "registration-secret", false); w.Code != 403 {
		t.Fatal("non-loopback accepted", w.Code)
	}
	if w := call(`{"sid":"S-1-5-21-1000","workspaceId":"default","name":"站点"}`, "wrong", true); w.Code != 401 {
		t.Fatal("bad credential accepted", w.Code)
	}
	w := call(`{"sid":"S-1-5-21-1000","workspaceId":"default","name":"站点","access":"password"}`, "registration-secret", true)
	if w.Code != 200 {
		t.Fatalf("publish %d %s", w.Code, w.Body.String())
	}
	var summary appSummary
	if err = json.Unmarshal(w.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if !summary.Enabled || summary.Version == "" || summary.AccessCode == "" || summary.ExpiresAt.Before(time.Now().Add(4*24*time.Hour)) {
		t.Fatalf("summary %#v", summary)
	}
	if !strings.Contains(summary.ShareURL, ":"+strconv.Itoa(summary.Port)) {
		t.Fatal("share URL misses app port", summary.ShareURL)
	}
	w = call(`{"sid":"S-1-5-21-1000","workspaceId":"default","name":"站点","access":"token"}`, "registration-secret", true)
	if w.Code != 200 {
		t.Fatalf("republish %d %s", w.Code, w.Body.String())
	}
	var republished appSummary
	if err = json.Unmarshal(w.Body.Bytes(), &republished); err != nil {
		t.Fatal(err)
	}
	if republished.ID != summary.ID || republished.Port != summary.Port || republished.AccessCode != "" {
		t.Fatalf("republish lost identity %#v vs %#v", republished, summary)
	}
	if !strings.Contains(republished.ShareURL, "/t/") {
		t.Fatal("token share URL missing token path", republished.ShareURL)
	}
	rows, err := apps.List(t.Context(), user.SID)
	if err != nil || len(rows) != 1 || len(rows[0].Versions) != 2 {
		t.Fatalf("apps %#v %v", rows, err)
	}
	// The runtime channel also serves the list operation.
	r := httptest.NewRequest("POST", "/internal/runtime/published-apps/list", strings.NewReader(`{"sid":"S-1-5-21-1000"}`))
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("Authorization", "Bearer registration-secret")
	list := httptest.NewRecorder()
	server.PublishedAppsRuntimeHandler().ServeHTTP(list, r)
	if list.Code != 200 || !strings.Contains(list.Body.String(), republished.ID) {
		t.Fatalf("list %d %s", list.Code, list.Body.String())
	}
}
