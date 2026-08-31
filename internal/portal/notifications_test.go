package portal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/notifications"
	"workagent3/internal/store"
)

func TestNotificationEndpointsUseAuthenticatedSIDAndPersistAcknowledgement(t *testing.T) {
	ctx := context.Background()
	users, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	notices, err := notifications.Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer notices.Close()
	aliceSID := "S-1-5-21-3101"
	bobSID := "S-1-5-21-3102"
	alice, err := users.CreateUser(ctx, "alice", aliceSID, "unused-hash")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := users.CreateUser(ctx, "bob", bobSID, "unused-hash"); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	aliceNotice, err := notices.Publish(ctx, contracts.NotificationInput{TargetSID: aliceSID, Kind: "automation", Title: "Complete", Message: "The run completed", DeepLink: "/automations/run-1", ExpiresAt: &expires})
	if err != nil {
		t.Fatal(err)
	}
	bobNotice, err := notices.Publish(ctx, contracts.NotificationInput{TargetSID: bobSID, Kind: "automation", Message: "Bob only"})
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(ctx, "alice-session", alice.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{Notifications: notices})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()

	list := notificationRequest(handler, http.MethodGet, "/api/portal/me/notifications", "alice-session")
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	var feed struct {
		Notifications []contracts.Notification `json:"notifications"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &feed); err != nil {
		t.Fatal(err)
	}
	if len(feed.Notifications) != 1 || feed.Notifications[0].ID != aliceNotice.ID {
		t.Fatalf("unexpected feed: %#v", feed.Notifications)
	}
	stored, err := notices.List(ctx, aliceSID, 20)
	if err != nil || len(stored) != 1 || stored[0].ReadAt == nil {
		t.Fatalf("notification was not marked read: %#v err=%v", stored, err)
	}

	foreign := notificationRequest(handler, http.MethodPost, "/api/portal/me/notifications/"+bobNotice.ID+"/acknowledge", "alice-session")
	if foreign.Code != http.StatusNotFound {
		t.Fatalf("foreign acknowledgement status=%d body=%s", foreign.Code, foreign.Body.String())
	}
	ack := notificationRequest(handler, http.MethodPost, "/api/portal/me/notifications/"+aliceNotice.ID+"/acknowledge", "alice-session")
	if ack.Code != http.StatusOK {
		t.Fatalf("ack status=%d body=%s", ack.Code, ack.Body.String())
	}
	stored, err = notices.List(ctx, aliceSID, 20)
	if err != nil || len(stored) != 0 {
		t.Fatalf("acknowledged notification remained visible: %#v err=%v", stored, err)
	}
}

func TestNotificationsGracefullyReturnEmptyFeedWhenModuleIsDisabled(t *testing.T) {
	ctx := context.Background()
	users, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	user, err := users.CreateUser(ctx, "alice", "S-1-5-21-3201", "unused-hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(ctx, "alice-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server, _ := New(users, StaticRouter{}, false)
	response := notificationRequest(server.Handler(), http.MethodGet, "/api/portal/me/notifications", "alice-session")
	if response.Code != http.StatusOK || response.Body.String() != "{\"notifications\":[]}\n" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func notificationRequest(handler http.Handler, method, path, session string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://portal.test"+path, nil)
	request.Header.Set("Origin", "http://portal.test")
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: session})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
