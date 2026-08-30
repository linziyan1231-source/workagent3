package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"workagent3/internal/auth"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestLoginAndRuntimeRoutingUsesAuthenticatedSID(t *testing.T) {
	runtime := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer internal-token" {
			t.Errorf("unexpected runtime authorization")
		}
		json.NewEncoder(writer).Encode(map[string]string{"path": request.URL.Path})
	}))
	defer runtime.Close()
	runtimeURL, _ := url.Parse(runtime.URL)
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	hash, _ := auth.HashPassword([]byte("correct horse battery staple"))
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash); err != nil {
		t.Fatal(err)
	}
	server, err := New(data, StaticRouter{"S-1-5-21-1000": {BaseURL: runtimeURL, Token: "internal-token"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"alice","password":"correct horse battery staple"}`))
	login.Header.Set("Content-Type", "application/json")
	loginResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("login status %d: %s", loginResponse.Code, loginResponse.Body.String())
	}
	cookie := loginResponse.Result().Cookies()[0]
	if cookie.Name != developmentSessionCookie || cookie.Secure {
		t.Fatalf("invalid development cookie: %#v", cookie)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/runtime/v1/sessions", nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"path":"/v1/sessions"`) {
		t.Fatalf("runtime response %d: %s", response.Code, response.Body.String())
	}
}

func TestSecurePortalUsesHostPrefixedCookie(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	server, _ := New(data, StaticRouter{}, true)
	if server.cookieName() != secureSessionCookie {
		t.Fatalf("secure cookie name %q", server.cookieName())
	}
}

func TestRuntimeRequiresAuthentication(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	endpoint, _ := url.Parse("http://127.0.0.1:1")
	server, _ := New(data, StaticRouter{"S-1-5-21-1000": runtimeapi.Endpoint{BaseURL: endpoint}}, false)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/runtime/v1/sessions", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", response.Code)
	}
}
