package portal

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"

	"workagent3/internal/auth"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

// The Harness backend (Node) answers "Expect: 100-continue" with an interim
// 100 Continue as soon as it sees the request headers, then responds with its
// real status. Proxied through the userhost gateway and the portal runtime
// proxy, the final status must reach the client unchanged.
func TestRuntimeProxyExpectContinuePreservesErrorStatus(t *testing.T) {
	harness := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.EqualFold(request.Header.Get("Expect"), "100-continue") {
			writer.WriteHeader(http.StatusContinue)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = writer.Write([]byte(`{"error":"model_overloaded"}`))
	}))
	defer harness.Close()

	// Mirror the production userhost gateway construction (bearer check in
	// front of a plain NewSingleHostReverseProxy, runtime_gateway.go).
	const runtimeToken = "runtime-token"
	harnessURL, _ := url.Parse(harness.URL)
	proxy := httputil.NewSingleHostReverseProxy(harnessURL)
	gateway := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		provided, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(provided), []byte(runtimeToken)) != 1 {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		proxy.ServeHTTP(writer, request)
	}))
	defer gateway.Close()

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
	gatewayURL, _ := url.Parse(gateway.URL)
	server, err := New(data, StaticRouter{user.SID: runtimeapi.Endpoint{BaseURL: gatewayURL, Token: runtimeToken}}, false)
	if err != nil {
		t.Fatal(err)
	}
	portal := httptest.NewServer(server.Handler())
	defer portal.Close()

	loginBody := strings.NewReader(`{"username":"alice","password":"correct horse battery staple"}`)
	login, err := http.NewRequest(http.MethodPost, portal.URL+"/api/auth/login", loginBody)
	if err != nil {
		t.Fatal(err)
	}
	login.Header.Set("Origin", portal.URL)
	login.Header.Set("Content-Type", "application/json")
	loginResponse, err := portal.Client().Do(login)
	if err != nil {
		t.Fatal(err)
	}
	cookies := loginResponse.Header.Values("Set-Cookie")
	_, _ = io.Copy(io.Discard, loginResponse.Body)
	loginResponse.Body.Close()
	if loginResponse.StatusCode != http.StatusOK {
		t.Fatalf("login failed with status %d", loginResponse.StatusCode)
	}
	if len(cookies) == 0 {
		t.Fatal("login did not set a session cookie")
	}
	session := strings.Split(cookies[0], ";")[0]

	post := func(expectContinue bool) int {
		body := strings.NewReader(`{"prompt":"hello"}`)
		request, err := http.NewRequest(http.MethodPost, portal.URL+"/api/runtime/v1/chat/completions", body)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", portal.URL)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", session)
		if expectContinue {
			request.Header.Set("Expect", "100-continue")
		}
		response, err := portal.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		payload, _ := io.ReadAll(response.Body)
		var decoded map[string]string
		if err := json.Unmarshal(payload, &decoded); err != nil || decoded["error"] != "model_overloaded" {
			t.Fatalf("expected harness error body, got %q", payload)
		}
		return response.StatusCode
	}

	if status := post(false); status != http.StatusServiceUnavailable {
		t.Fatalf("without Expect: 100-continue the runtime proxy changed status 503 to %d", status)
	}
	if status := post(true); status != http.StatusServiceUnavailable {
		t.Fatalf("with Expect: 100-continue the runtime proxy changed status 503 to %d", status)
	}
}
