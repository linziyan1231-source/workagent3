package portal

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"workagent3/internal/auth"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestRuntimeProxyPreservesCreatedStatus(t *testing.T) {
	runtime := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"id":"workspace-1"}`))
	}))
	defer runtime.Close()
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
	target, _ := url.Parse(runtime.URL)
	server, err := New(data, StaticRouter{user.SID: runtimeapi.Endpoint{BaseURL: target, Token: "runtime-token"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRequest(http.MethodPost, "http://portal.test/api/auth/login", strings.NewReader(`{"username":"alice","password":"correct horse battery staple"}`))
	login.Header.Set("Origin", "http://portal.test")
	loginResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(loginResponse, login)
	request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/runtime/v1/workspaces", strings.NewReader(`{"name":"Workspace"}`))
	request.Header.Set("Origin", "http://portal.test")
	request.AddCookie(loginResponse.Result().Cookies()[0])
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("runtime proxy changed status 201 to %d", response.Code)
	}
}
