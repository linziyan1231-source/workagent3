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
	login.Header.Set("Origin", "http://example.com")
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

func TestTwoBrowserUsersCannotRouteToEachOthersRuntime(t *testing.T) {
	runtimeFor := func(owner string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			json.NewEncoder(writer).Encode(map[string]string{"owner": owner})
		}))
	}
	aliceRuntime, bobRuntime := runtimeFor("alice"), runtimeFor("bob")
	defer aliceRuntime.Close()
	defer bobRuntime.Close()
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	for _, user := range []struct{ username, sid string }{{"alice", "S-1-5-21-1000"}, {"bob", "S-1-5-21-2000"}} {
		hash, _ := auth.HashPassword([]byte("correct horse battery staple"))
		if _, err := data.CreateUser(t.Context(), user.username, user.sid, hash); err != nil {
			t.Fatal(err)
		}
	}
	aliceURL, _ := url.Parse(aliceRuntime.URL)
	bobURL, _ := url.Parse(bobRuntime.URL)
	server, err := New(data, StaticRouter{
		"S-1-5-21-1000": {BaseURL: aliceURL, Token: "alice-token"},
		"S-1-5-21-2000": {BaseURL: bobURL, Token: "bob-token"},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()
	login := func(username string) *http.Cookie {
		request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/auth/login", strings.NewReader(`{"username":"`+username+`","password":"correct horse battery staple"}`))
		request.Header.Set("Origin", "http://portal.test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("login %s returned %d: %s", username, response.Code, response.Body.String())
		}
		return response.Result().Cookies()[0]
	}
	requestRuntime := func(cookie *http.Cookie) string {
		request := httptest.NewRequest(http.MethodGet, "/api/runtime/v1/sessions", nil)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Body.String()
	}
	if body := requestRuntime(login("alice")); !strings.Contains(body, `"owner":"alice"`) || strings.Contains(body, `"owner":"bob"`) {
		t.Fatalf("Alice was routed outside her SID runtime: %s", body)
	}
	if body := requestRuntime(login("bob")); !strings.Contains(body, `"owner":"bob"`) || strings.Contains(body, `"owner":"alice"`) {
		t.Fatalf("Bob was routed outside his SID runtime: %s", body)
	}
}

func TestPortalRejectsCrossOriginWrites(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	server, _ := New(data, StaticRouter{}, false)

	for _, origin := range []string{"", "https://evil.example"} {
		request := httptest.NewRequest(http.MethodPost, "http://workagent.example/api/auth/login", strings.NewReader(`{}`))
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "cross_origin_request") {
			t.Fatalf("origin %q returned %d: %s", origin, response.Code, response.Body.String())
		}
	}
}

func TestSecurePortalAcceptsMatchingHTTPSOrigin(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	server, _ := New(data, StaticRouter{}, true)
	request := httptest.NewRequest(http.MethodPost, "https://workagent.example/api/auth/login", strings.NewReader(`{}`))
	request.Header.Set("Origin", "https://workagent.example")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("matching origin did not reach login handler: %d", response.Code)
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
