package portal

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
	"workagent3/internal/publishedapps"
	"workagent3/internal/store"
)

func TestApplicationNavigationPreservesFormOriginWithoutRelaxingCSRF(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	owner, err := data.CreateUser(t.Context(), "owner", "S-1-5-21-1000", "unused-hash")
	if err != nil {
		t.Fatal(err)
	}
	if err = data.CreateSession(t.Context(), "navigation-session", owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	apps, err := publishedapps.Open(filepath.Join(t.TempDir(), "apps.db"), 22300, 22309, publishedapps.DefaultMaxEmployeePorts)
	if err != nil {
		t.Fatal(err)
	}
	defer apps.Close()
	app, err := apps.Create(t.Context(), publishedapps.App{OwnerSID: owner.SID, OwnerID: owner.ID, WorkspaceID: "default", Name: "private-navigation", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	app.Enabled = true
	app.Version = "version"
	app, err = apps.Update(t.Context(), app, app.Revision)
	if err != nil {
		t.Fatal(err)
	}
	const portalOrigin = "http://192.0.2.1:8080"
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{PublishedApps: PublishedAppsConfig{Store: apps, PublicURL: portalOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	// Exercise the real HTTP handlers and security middleware without reserving
	// system ports; listener establishment itself has separate acceptance tests.
	server.apps.listeners[app.ID+"false"] = &http.Server{}
	server.apps.listeners[app.ID+"true"] = &http.Server{}
	handler := server.Handler()
	call := func(method, path, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, portalOrigin+path, nil)
		r.Header.Set("Origin", origin)
		r.AddCookie(&http.Cookie{Name: server.cookieName(), Value: "navigation-session"})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	entry := call("GET", "/apps/"+app.ID, "")
	if entry.Code != 200 || entry.Header().Get("Referrer-Policy") != "origin" {
		t.Fatalf("entry must preserve native form Origin: %d, policy %q", entry.Code, entry.Header().Get("Referrer-Policy"))
	}
	openPath := "/api/portal/apps/" + app.ID + "/open"
	for _, origin := range []string{"", "null", "http://192.0.2.1:22300", "http://other.test"} {
		if response := call("POST", openPath, origin); response.Code != 403 || !strings.Contains(response.Body.String(), "cross_origin_request") {
			t.Fatalf("invalid Origin %q accepted: %d", origin, response.Code)
		}
	}
	exchange := call("POST", openPath, portalOrigin)
	if exchange.Code != 200 || exchange.Header().Get("Referrer-Policy") != "origin" {
		t.Fatalf("exchange must preserve cross-port form Origin: %d, policy %q", exchange.Code, exchange.Header().Get("Referrer-Policy"))
	}
	appOrigin := "http://192.0.2.1:" + strconv.Itoa(app.Port)
	if !strings.Contains(exchange.Body.String(), `action="`+appOrigin+`/__workagent/access"`) {
		t.Fatal("exchange form target changed")
	}
	match := regexp.MustCompile(`name="ticket" value="([^"]+)"`).FindStringSubmatch(exchange.Body.String())
	if len(match) != 2 {
		t.Fatal("one-use form ticket missing")
	}
	exchangeRequest := func(origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", appOrigin+"/__workagent/access", strings.NewReader(url.Values{"ticket": {match[1]}}.Encode()))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		server.apps.handler(app.ID, false).ServeHTTP(w, r)
		return w
	}
	for _, origin := range []string{"", "null", appOrigin, "http://other.test"} {
		if response := exchangeRequest(origin); response.Code != 403 {
			t.Fatalf("invalid exchange Origin %q accepted: %d", origin, response.Code)
		}
	}
	granted := exchangeRequest(portalOrigin)
	if granted.Code != 303 || len(granted.Result().Cookies()) != 1 || !granted.Result().Cookies()[0].HttpOnly {
		t.Fatal("valid Portal-origin ticket exchange failed")
	}
	if repeated := exchangeRequest(portalOrigin); repeated.Code != 403 {
		t.Fatal("ticket replay accepted")
	}
	if ordinary := call("GET", "/healthz", ""); ordinary.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("unrelated Portal referrer policy changed")
	}
}
