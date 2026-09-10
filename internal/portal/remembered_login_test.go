package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/store"
)

func TestSavedLoginIsOpaqueAndSurvivesLogout(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	hash, _ := auth.HashPassword([]byte("correct horse battery staple"))
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash); err != nil {
		t.Fatal(err)
	}
	s, err := New(data, StaticRouter{}, true)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	s.now = func() time.Time { return now }
	call := func(method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://portal.test"+path, strings.NewReader(body))
		r.Header.Set("Origin", "https://portal.test")
		for _, c := range cookies {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	login := func() (*http.Cookie, *http.Cookie) {
		w := call("POST", "/api/auth/login", `{"username":"alice","password":"correct horse battery staple","remember":true}`)
		if w.Code != 200 {
			t.Fatalf("login: %d", w.Code)
		}
		var session, saved *http.Cookie
		for _, c := range w.Result().Cookies() {
			if c.Name == s.cookieName() {
				session = c
			} else if c.Name == s.rememberedCookie("").Name {
				saved = c
			}
		}
		if session == nil || saved == nil || !saved.HttpOnly || !saved.Secure || saved.SameSite != http.SameSiteStrictMode || saved.MaxAge != 30*86400 {
			t.Fatal("missing protected device credential")
		}
		return session, saved
	}
	session, saved := login()
	if call("POST", "/api/auth/logout", "", session).Code != 204 {
		t.Fatal("logout failed")
	}
	if call("GET", "/api/auth/me", "", session).Code != 401 {
		t.Fatal("logout did not revoke session")
	}
	probe := call("GET", "/api/auth/remembered", "", saved)
	var fields map[string]any
	if json.Unmarshal(probe.Body.Bytes(), &fields) != nil || len(fields) != 1 || fields["username"] != "alice" {
		t.Fatal("probe must expose only username")
	}
	if probe.Header().Get("Cache-Control") == "" {
		t.Fatal("credential status must not be cached")
	}
	if call("GET", "/api/auth/me", "", &http.Cookie{Name: s.cookieName(), Value: saved.Value}).Code != 401 {
		t.Fatal("device credential accepted as a session")
	}
	for _, body := range []string{`{"username":"bob","useRemembered":true}`, `{"username":"alice","useRemembered":true,"password":"wrong"}`} {
		if call("POST", "/api/auth/login", body, saved).Code != 401 {
			t.Fatal("credential accepted for mismatched identity or password")
		}
	}
	body := `{"username":"alice","useRemembered":true,"remember":true}`
	if call("POST", "/api/auth/login", body).Code != 401 {
		t.Fatal("login accepted without saved credential")
	}
	if call("POST", "/api/auth/login", body, saved).Code != 200 {
		t.Fatal("saved login failed after logout")
	}
	now = now.Add(31 * 24 * time.Hour)
	if call("POST", "/api/auth/login", body, saved).Code != 401 {
		t.Fatal("expired saved login accepted")
	}
	now = now.Add(-31 * 24 * time.Hour)
	if call("DELETE", "/api/auth/remembered", "", saved).Code != 204 {
		t.Fatal("forget failed")
	}
	if call("POST", "/api/auth/login", body, saved).Code != 401 {
		t.Fatal("forgotten saved login accepted")
	}
	for _, revoke := range []struct {
		name   string
		action func() error
	}{
		{"password change", func() error { return data.ResetUserPassword(t.Context(), "alice", hash) }},
		{"role change", func() error { return data.SetUserAdmin(t.Context(), "alice", true) }},
		{"disable and enable", func() error {
			if err := data.SetUserEnabled(t.Context(), "alice", false); err != nil {
				return err
			}
			return data.SetUserEnabled(t.Context(), "alice", true)
		}},
	} {
		_, saved = login()
		if err := revoke.action(); err != nil {
			t.Fatal(err)
		}
		if call("POST", "/api/auth/login", body, saved).Code != 401 {
			t.Fatalf("%s did not revoke saved login", revoke.name)
		}
	}
	_, saved = login()
	w := call("POST", "/api/auth/login", `{"username":"alice","password":"correct horse battery staple","remember":false}`, saved)
	if w.Code != 200 || call("POST", "/api/auth/login", body, saved).Code != 401 {
		t.Fatal("ordinary login did not forget device")
	}
}
