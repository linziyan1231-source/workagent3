package userhost

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"workagent3/internal/auth"
	"workagent3/internal/portal"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestRuntimeGatewayPreservesCreatedStatus(t *testing.T) {
	harness := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"id":"workspace-1"}`))
	}))
	defer harness.Close()
	target, _ := url.Parse(harness.URL)
	handler := newRuntimeGatewayHandlerWithControl(nil, nil, nil, nil, nil, nil, nil, target, "runtime-token", nil, nil)
	request := httptest.NewRequest(http.MethodPost, "/v1/workspaces", nil)
	request.Header.Set("Authorization", "Bearer runtime-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("runtime gateway changed status 201 to %d", response.Code)
	}
}

func TestPortalAndRuntimeGatewayPreserveCreatedStatus(t *testing.T) {
	harness := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"id":"workspace-1"}`))
	}))
	defer harness.Close()
	harnessURL, _ := url.Parse(harness.URL)
	gateway := httptest.NewServer(newRuntimeGatewayHandlerWithControl(nil, nil, nil, nil, nil, nil, nil, harnessURL, "runtime-token", nil, nil))
	defer gateway.Close()
	gatewayURL, _ := url.Parse(gateway.URL)
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
	server, err := portal.New(data, portal.StaticRouter{user.SID: runtimeapi.Endpoint{BaseURL: gatewayURL, Token: "runtime-token"}}, false)
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
		t.Fatalf("proxy chain changed status 201 to %d", response.Code)
	}
}
