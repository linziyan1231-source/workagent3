package portal

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestSystemStatusAndRuntimeRestartAreSIDScopedAndRedacted(t *testing.T) {
	users, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	user, err := users.CreateUser(t.Context(), "alice", "S-1-5-21-5101", "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(t.Context(), "system-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var statusCorrelation, restartCorrelation string
	runtime := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer private-runtime-token" {
			t.Fatalf("runtime token missing: %#v", request.Header)
		}
		switch request.URL.Path {
		case "/v1/system/status":
			statusCorrelation = request.Header.Get(correlationHeader)
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"components":[{"id":"userhost","status":"healthy"},{"id":"harness","status":"healthy"}]}`))
		case "/v1/system/restart":
			restartCorrelation = request.Header.Get(correlationHeader)
			writer.WriteHeader(http.StatusAccepted)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer runtime.Close()
	target, _ := url.Parse(runtime.URL)
	server, err := New(users, StaticRouter{user.SID: runtimeapi.Endpoint{BaseURL: target, Token: "private-runtime-token"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK || !strings.Contains(health.Body.String(), `"status":"healthy"`) {
		t.Fatalf("health=%d body=%s", health.Code, health.Body.String())
	}
	status := systemRequest(handler, http.MethodGet, "/api/system/status", "system-session")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"id":"harness","status":"healthy"`) || statusCorrelation == "" || statusCorrelation != status.Header().Get(correlationHeader) {
		t.Fatalf("status=%d correlation=%q downstream=%q body=%s", status.Code, status.Header().Get(correlationHeader), statusCorrelation, status.Body.String())
	}
	for _, secret := range []string{user.SID, "private-runtime-token", runtime.URL} {
		if strings.Contains(status.Body.String(), secret) {
			t.Fatalf("system status leaked %q: %s", secret, status.Body.String())
		}
	}
	diagnostics := systemRequest(handler, http.MethodGet, "/api/system/diagnostics", "system-session")
	if diagnostics.Code != http.StatusOK || diagnostics.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("diagnostics=%d type=%q", diagnostics.Code, diagnostics.Header().Get("Content-Type"))
	}
	archive, err := zip.NewReader(bytes.NewReader(diagnostics.Body.Bytes()), int64(diagnostics.Body.Len()))
	if err != nil || len(archive.File) != 1 || archive.File[0].Name != "manifest.json" {
		t.Fatalf("diagnostic archive=%#v err=%v", archive, err)
	}
	entry, err := archive.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	manifest, _ := io.ReadAll(entry)
	entry.Close()
	if !strings.Contains(string(manifest), `"scope":"authenticated-user-redacted"`) || !strings.Contains(string(manifest), `"id":"harness"`) {
		t.Fatalf("manifest=%s", manifest)
	}
	for _, secret := range []string{user.SID, "private-runtime-token", runtime.URL} {
		if strings.Contains(string(manifest), secret) {
			t.Fatalf("diagnostics leaked %q: %s", secret, manifest)
		}
	}
	restart := systemRequest(handler, http.MethodPost, "/api/system/runtime/restart", "system-session")
	if restart.Code != http.StatusAccepted || !strings.Contains(restart.Body.String(), `"reconnect_after_ms":4000`) || restartCorrelation == "" || restartCorrelation != restart.Header().Get(correlationHeader) {
		t.Fatalf("restart=%d correlation=%q downstream=%q body=%s", restart.Code, restart.Header().Get(correlationHeader), restartCorrelation, restart.Body.String())
	}
}

func systemRequest(handler http.Handler, method, path, session string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://portal.test"+path, nil)
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: session})
	if method != http.MethodGet {
		request.Header.Set("Origin", "http://portal.test")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
