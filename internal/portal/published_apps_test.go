package portal

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"workagent3/internal/publishedapps"
	"workagent3/internal/store"
)

func TestApplicationGatewayStripsPlatformCredentialsAndCookieResponses(t *testing.T) {
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" {
			t.Error("platform cookie leaked")
		}
		if r.Header.Get("Authorization") != "Bearer internal-token" {
			t.Error("wrong runtime authorization")
		}
		if r.Header.Get("X-WorkAgent-App-Authorization") != "Bearer business" {
			t.Error("application authorization lost")
		}
		if r.Header.Get("X-WorkAgent-App-Version") != "v1" {
			t.Error("version injection")
		}
		w.Header().Set("Set-Cookie", "workagent-session=attacker")
		w.Header().Set("Clear-Site-Data", "\"cookies\"")
		_, _ = w.Write([]byte("hello"))
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	if _, err = data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	user, err := data.UserByUsername(t.Context(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	apps, err := publishedapps.Open(filepath.Join(t.TempDir(), "apps.db"), 21000, 21009, publishedapps.DefaultMaxEmployeePorts)
	if err != nil {
		t.Fatal(err)
	}
	defer apps.Close()
	a, err := apps.Create(t.Context(), publishedapps.App{OwnerSID: user.SID, OwnerID: user.ID, WorkspaceID: "p", Name: "demo", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	a.Enabled = true
	a.Access = "public"
	a.Version = "v1"
	a, err = apps.Update(t.Context(), a, a.Revision)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(data, StaticRouter{"S-1-5-21-1000": {BaseURL: target, Token: "internal-token"}}, false, Modules{PublishedApps: PublishedAppsConfig{Store: apps, PublicURL: "http://192.0.2.1:8080"}})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "http://192.0.2.1:"+strconv.Itoa(a.Port)+"/", nil)
	r.Header.Set("Cookie", "workagent-session=private")
	r.Header.Set("Authorization", "Bearer business")
	r.Header.Set("X-WorkAgent-App-Version", "forged")
	w := httptest.NewRecorder()
	server.apps.handler(a.ID, false).ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "hello" {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Set-Cookie") != "" || w.Header().Get("Clear-Site-Data") != "" {
		t.Fatal("unsafe response header")
	}
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors http://192.0.2.1:8080") {
		t.Fatal("CSP")
	}
	r = httptest.NewRequest("POST", "http://192.0.2.1:"+strconv.Itoa(a.Port)+"/", nil)
	r.Header.Set("Origin", "http://192.0.2.1:21008")
	w = httptest.NewRecorder()
	server.apps.handler(a.ID, false).ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross app write accepted", w.Code)
	}
}
