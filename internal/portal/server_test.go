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

func TestTwoBrowserUsersCannotEnumerateOrSendToEachOthersSessions(t *testing.T) {
	type isolatedRuntime struct {
		owner     string
		sessionID string
		turns     int
	}
	runtimeFor := func(runtime *isolatedRuntime) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.Header.Get("Authorization") != "Bearer "+runtime.owner+"-token" {
				t.Errorf("%s Runtime received the wrong credential", runtime.owner)
			}
			switch {
			case request.Method == http.MethodGet && request.URL.Path == "/v1/sessions":
				json.NewEncoder(writer).Encode([]map[string]string{{"id": runtime.sessionID, "owner": runtime.owner}})
			case request.Method == http.MethodGet && request.URL.Path == "/v1/sessions/"+runtime.sessionID:
				json.NewEncoder(writer).Encode(map[string]string{"id": runtime.sessionID, "owner": runtime.owner})
			case request.Method == http.MethodPost && request.URL.Path == "/v1/sessions/"+runtime.sessionID+"/turns":
				runtime.turns++
				writer.WriteHeader(http.StatusAccepted)
				json.NewEncoder(writer).Encode(map[string]bool{"accepted": true})
			default:
				writeError(writer, http.StatusNotFound, "session_not_found")
			}
		}))
	}
	aliceState := &isolatedRuntime{owner: "alice", sessionID: "session-alice-private"}
	bobState := &isolatedRuntime{owner: "bob", sessionID: "session-bob-private"}
	aliceRuntime, bobRuntime := runtimeFor(aliceState), runtimeFor(bobState)
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
	requestRuntime := func(cookie *http.Cookie, method, path, forgedSID string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "http://portal.test"+path, strings.NewReader(`{"content":"private turn"}`))
		request.AddCookie(cookie)
		if method != http.MethodGet && method != http.MethodHead {
			request.Header.Set("Origin", "http://portal.test")
		}
		if forgedSID != "" {
			request.Header.Set("X-WorkAgent-SID", forgedSID)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	aliceCookie, bobCookie := login("alice"), login("bob")
	if body := requestRuntime(aliceCookie, http.MethodGet, "/api/runtime/v1/sessions", "").Body.String(); !strings.Contains(body, aliceState.sessionID) || strings.Contains(body, bobState.sessionID) {
		t.Fatalf("Alice was routed outside her SID runtime: %s", body)
	}
	if body := requestRuntime(bobCookie, http.MethodGet, "/api/runtime/v1/sessions", aliceState.owner).Body.String(); !strings.Contains(body, bobState.sessionID) || strings.Contains(body, aliceState.sessionID) {
		t.Fatalf("Bob was routed outside his SID runtime: %s", body)
	}
	for _, attempt := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/runtime/v1/sessions/" + aliceState.sessionID},
		{http.MethodPost, "/api/runtime/v1/sessions/" + aliceState.sessionID + "/turns"},
	} {
		response := requestRuntime(bobCookie, attempt.method, attempt.path, aliceState.owner)
		if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "session_not_found") {
			t.Fatalf("Bob cross-SID request %s %s returned %d: %s", attempt.method, attempt.path, response.Code, response.Body.String())
		}
	}
	if aliceState.turns != 0 || bobState.turns != 0 {
		t.Fatalf("cross-SID send reached a private Session: alice=%d bob=%d", aliceState.turns, bobState.turns)
	}
	if response := requestRuntime(aliceCookie, http.MethodPost, "/api/runtime/v1/sessions/"+aliceState.sessionID+"/turns", ""); response.Code != http.StatusAccepted || aliceState.turns != 1 {
		t.Fatalf("same-SID send failed: status=%d turns=%d body=%s", response.Code, aliceState.turns, response.Body.String())
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
