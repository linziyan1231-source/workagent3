package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/store"
)

func TestRememberedLoginLifetimeAndLogout(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	hash, _ := auth.HashPassword([]byte("correct horse battery staple"))
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash); err != nil {
		t.Fatal(err)
	}
	server, err := New(data, StaticRouter{}, true)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC)
	server.now = func() time.Time { return now }
	for _, choice := range []struct {
		name, body string
		remembered bool
	}{
		{"ordinary", `{"username":"alice","password":"correct horse battery staple","remember":false}`, false},
		{"remembered", `{"username":"alice","password":"correct horse battery staple","remember":true}`, true},
	} {
		t.Run(choice.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "https://portal.test/api/auth/login", strings.NewReader(choice.body))
			req.Header.Set("Origin", "https://portal.test")
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("login status %d", rec.Code)
			}
			var cookie *http.Cookie
			for _, candidate := range rec.Result().Cookies() {
				if candidate.Name == server.cookieName() {
					cookie = candidate
				}
			}
			if cookie == nil {
				t.Fatal("session cookie missing")
			}
			if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
				t.Fatal("session cookie security attributes missing")
			}
			if choice.remembered {
				if cookie.MaxAge != 30*24*60*60 || !cookie.Expires.Equal(now.Add(30*24*time.Hour)) {
					t.Fatal("remembered cookie must persist for 30 days")
				}
			} else if cookie.MaxAge != 0 || !cookie.Expires.IsZero() {
				t.Fatal("ordinary cookie must be a browser-session cookie")
			}
			_, err = data.UserBySession(t.Context(), cookie.Value, now.Add(13*time.Hour))
			if (err == nil) != choice.remembered {
				t.Fatal("server expiry does not match remember choice")
			}
			if _, err := data.UserBySession(t.Context(), cookie.Value, now.Add(31*24*time.Hour)); err == nil {
				t.Fatal("expired remembered token accepted")
			}
			logout := httptest.NewRequest(http.MethodPost, "https://portal.test/api/auth/logout", nil)
			logout.Header.Set("Origin", "https://portal.test")
			logout.AddCookie(cookie)
			loggedOut := httptest.NewRecorder()
			server.Handler().ServeHTTP(loggedOut, logout)
			if loggedOut.Code != http.StatusNoContent {
				t.Fatalf("logout status %d", loggedOut.Code)
			}
			if _, err := data.UserBySession(t.Context(), cookie.Value, now); err == nil {
				t.Fatal("logout did not revoke session")
			}
		})
	}
}
