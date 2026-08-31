package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestPortalAuditRecordsLoginResultWithoutRequestSecrets(t *testing.T) {
	users, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	auditStore, err := audit.Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer auditStore.Close()
	password := "correct horse battery staple"
	hash, err := auth.HashPassword([]byte(password))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := users.CreateUser(t.Context(), "alice", "S-1-5-21-4101", hash); err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{Audit: auditStore})
	if err != nil {
		t.Fatal(err)
	}

	login := auditRequest(server.Handler(), http.MethodPost, "/api/auth/login", `{"username":"alice","password":"`+password+`"}`, "")
	if login.Code != http.StatusOK || login.Header().Get(correlationHeader) == "" {
		t.Fatalf("login status=%d correlation=%q body=%s", login.Code, login.Header().Get(correlationHeader), login.Body.String())
	}
	denied := auditRequest(server.Handler(), http.MethodPost, "/api/auth/login", `{"username":"alice","password":"wrong-password"}`, "")
	if denied.Code != http.StatusUnauthorized {
		t.Fatalf("denied login status=%d body=%s", denied.Code, denied.Body.String())
	}
	events, err := auditStore.List(t.Context(), contracts.AuditQuery{Actor: "alice", Limit: 10})
	if err != nil || len(events) != 2 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	results := map[string]bool{}
	for _, event := range events {
		if event.Target != "/api/auth/login" || event.Action != "POST /api/auth/login" || event.CorrelationID == "" {
			t.Fatalf("unexpected event: %#v", event)
		}
		results[event.Result] = true
	}
	if !results["success"] || !results["denied"] {
		t.Fatalf("missing audit results: %#v", results)
	}
	encoded, _ := json.Marshal(events)
	for _, secret := range []string{password, "wrong-password", hash} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("audit leaked secret %q: %s", secret, encoded)
		}
	}
}

func TestPortalReplacesForgedCorrelationIDAndPropagatesServerValue(t *testing.T) {
	users, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	user, err := users.CreateUser(t.Context(), "alice", "S-1-5-21-4201", "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(t.Context(), "audit-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var downstreamCorrelation string
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		downstreamCorrelation = request.Header.Get(correlationHeader)
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	server, err := New(users, StaticRouter{user.SID: runtimeapi.Endpoint{BaseURL: target, Token: "private-runtime-token"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://portal.test/api/runtime/v1/sessions", nil)
	request.Header.Set(correlationHeader, "browser-forged-correlation")
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "audit-session"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	correlation := response.Header().Get(correlationHeader)
	if response.Code != http.StatusNoContent || correlation == "" || correlation == "browser-forged-correlation" || downstreamCorrelation != correlation {
		t.Fatalf("status=%d response=%q downstream=%q", response.Code, correlation, downstreamCorrelation)
	}
}

func auditRequest(handler http.Handler, method, path, body, session string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://portal.test"+path, strings.NewReader(body))
	request.Header.Set("Origin", "http://portal.test")
	request.Header.Set("Content-Type", "application/json")
	if session != "" {
		request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: session})
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
