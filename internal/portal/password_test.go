package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"workagent3/internal/auth"
	"workagent3/internal/store"
)

func TestPasswordChangeRotatesCredentialsAndRevokesSessions(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	oldPassword := "correct horse battery staple"
	newPassword := "replacement horse battery staple"
	hash, _ := auth.HashPassword([]byte(oldPassword))
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash); err != nil {
		t.Fatal(err)
	}
	server, _ := New(data, StaticRouter{}, false)
	handler := server.Handler()
	oldCookie := passwordTestLogin(t, handler, oldPassword, http.StatusOK)

	change := httptest.NewRequest(http.MethodPost, "http://portal.test/api/auth/password", strings.NewReader(`{"username":"alice","current_password":"`+oldPassword+`","new_password":"`+newPassword+`","confirm_password":"`+newPassword+`"}`))
	change.Header.Set("Origin", "http://portal.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, change)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"success":true`) {
		t.Fatalf("change password returned %d: %s", response.Code, response.Body.String())
	}

	me := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	me.AddCookie(oldCookie)
	meResponse := httptest.NewRecorder()
	handler.ServeHTTP(meResponse, me)
	if meResponse.Code != http.StatusUnauthorized {
		t.Fatalf("old session survived password change: %d", meResponse.Code)
	}
	passwordTestLogin(t, handler, oldPassword, http.StatusUnauthorized)
	passwordTestLogin(t, handler, newPassword, http.StatusOK)
}

func TestPasswordChangeRejectsInvalidRequests(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	hash, _ := auth.HashPassword([]byte("correct horse battery staple"))
	_, _ = data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash)
	server, _ := New(data, StaticRouter{}, false)

	for _, test := range []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{"wrong current password", `{"username":"alice","current_password":"incorrect horse battery staple","new_password":"replacement horse battery staple","confirm_password":"replacement horse battery staple"}`, http.StatusUnauthorized, "INVALID_CURRENT_PASSWORD"},
		{"confirmation mismatch", `{"username":"alice","current_password":"correct horse battery staple","new_password":"replacement horse battery staple","confirm_password":"different replacement password"}`, http.StatusBadRequest, "PASSWORD_MISMATCH"},
		{"password policy", `{"username":"alice","current_password":"correct horse battery staple","new_password":"short","confirm_password":"short"}`, http.StatusBadRequest, "PASSWORD_POLICY"},
		{"password reuse", `{"username":"alice","current_password":"correct horse battery staple","new_password":"correct horse battery staple","confirm_password":"correct horse battery staple"}`, http.StatusBadRequest, "PASSWORD_REUSED"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/auth/password", strings.NewReader(test.body))
			request.Header.Set("Origin", "http://portal.test")
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != test.status || !strings.Contains(response.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("returned %d: %s", response.Code, response.Body.String())
			}
		})
	}
}

func passwordTestLogin(t *testing.T, handler http.Handler, password string, expectedStatus int) *http.Cookie {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/auth/login", strings.NewReader(`{"username":"alice","password":"`+password+`"}`))
	request.Header.Set("Origin", "http://portal.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("login returned %d: %s", response.Code, response.Body.String())
	}
	if expectedStatus == http.StatusOK {
		return response.Result().Cookies()[0]
	}
	return nil
}
