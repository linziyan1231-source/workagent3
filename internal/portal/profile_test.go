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

func TestProfileRoundTripUsesAuthenticatedPortalUser(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	hash, _ := auth.HashPassword([]byte("correct horse battery staple"))
	user, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(t.Context(), "profile-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server, err := New(data, StaticRouter{}, false)
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()
	request := httptest.NewRequest(http.MethodPatch, "http://portal.test/api/portal/me/profile", strings.NewReader(`{"display_name":"Alice Chen","collaboration_enabled":true}`))
	request.Header.Set("Origin", "http://portal.test")
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "profile-session"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"display_name":"Alice Chen"`) || !strings.Contains(response.Body.String(), `"collaboration_enabled":true`) || strings.Contains(response.Body.String(), "S-1-") {
		t.Fatalf("profile update = %d %s", response.Code, response.Body.String())
	}

	get := httptest.NewRequest(http.MethodGet, "/api/portal/me/profile", nil)
	get.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "profile-session"})
	read := httptest.NewRecorder()
	handler.ServeHTTP(read, get)
	if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), `"display_name":"Alice Chen"`) || !strings.Contains(read.Body.String(), `"collaboration_capable":true`) {
		t.Fatalf("profile read = %d %s", read.Code, read.Body.String())
	}
}
