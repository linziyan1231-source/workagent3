package notifications

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

type runtimeCredentialStub map[string]string

func (credentials runtimeCredentialStub) RuntimeRegistrationAuthorized(_ context.Context, sid, credential string) bool {
	return credentials[sid] == credential
}

func invokeRuntimeNotification(handler http.Handler, body, credential, remote string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/internal/runtime/notifications", strings.NewReader(body))
	request.RemoteAddr = remote
	request.Header.Set("Authorization", "Bearer "+credential)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestRuntimeNotificationHandlerPublishesForAuthenticatedSID(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	const sid = "S-1-5-21-100"
	handler := RuntimeHandler(store, runtimeCredentialStub{sid: "sid-secret"})
	response := invokeRuntimeNotification(handler,
		`{"sid":"`+sid+`","kind":"automation","title":"Automation completed","message":"Automation \"Report\" finished successfully.","deep_link":"/scheduled/automation-1"}`,
		"sid-secret", "127.0.0.1:55000")
	if response.Code != http.StatusNoContent {
		t.Fatalf("publish response %d: %s", response.Code, response.Body.String())
	}
	feed, err := store.List(t.Context(), sid, 20)
	if err != nil || len(feed) != 1 {
		t.Fatalf("feed = %#v, %v", feed, err)
	}
	if feed[0].Kind != "automation" || feed[0].DeepLink != "/scheduled/automation-1" {
		t.Fatalf("unexpected notification: %#v", feed[0])
	}
}

func TestRuntimeNotificationHandlerRejectsRemoteCrossSIDAndInvalidInput(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	handler := RuntimeHandler(store, runtimeCredentialStub{"S-1-5-21-100": "alice-secret"})
	body := `{"sid":"S-1-5-21-100","kind":"team","message":"done"}`
	if response := invokeRuntimeNotification(handler, body, "alice-secret", "192.0.2.20:55000"); response.Code != http.StatusForbidden {
		t.Fatalf("remote publish returned %d: %s", response.Code, response.Body.String())
	}
	crossSID := `{"sid":"S-1-5-21-200","kind":"team","message":"done"}`
	if response := invokeRuntimeNotification(handler, crossSID, "alice-secret", "127.0.0.1:55000"); response.Code != http.StatusUnauthorized {
		t.Fatalf("cross-SID publish returned %d: %s", response.Code, response.Body.String())
	}
	absoluteLink := `{"sid":"S-1-5-21-100","kind":"team","message":"done","deep_link":"https://evil.example/x"}`
	if response := invokeRuntimeNotification(handler, absoluteLink, "alice-secret", "127.0.0.1:55000"); response.Code != http.StatusBadRequest {
		t.Fatalf("absolute deep link returned %d: %s", response.Code, response.Body.String())
	}
}
