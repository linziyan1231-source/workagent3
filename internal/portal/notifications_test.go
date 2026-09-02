package portal

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
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

func TestNotificationStreamPushesFeedOnConnectPublishAndSurvivesDisconnect(t *testing.T) {
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
	aliceSID := "S-1-5-21-3103"
	alice, err := users.CreateUser(ctx, "alice", aliceSID, "unused-hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(ctx, "alice-session", alice.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	first, err := notices.Publish(ctx, contracts.NotificationInput{TargetSID: aliceSID, Kind: "team", Message: "first"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{Notifications: notices})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()

	requestCtx, cancel := context.WithCancel(ctx)
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, httpServer.URL+"/api/portal/me/notifications/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "alice-session"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("stream status=%d content-type=%s", response.StatusCode, response.Header.Get("Content-Type"))
	}
	reader := bufio.NewReader(response.Body)
	readEvent := func() string {
		t.Helper()
		var block strings.Builder
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("read stream: %v", err)
			}
			if line == "\n" {
				return block.String()
			}
			block.WriteString(line)
		}
	}
	if event := readEvent(); !strings.Contains(event, "event: notifications") || !strings.Contains(event, first.ID) {
		t.Fatalf("initial feed event = %q", event)
	}
	second, err := notices.Publish(ctx, contracts.NotificationInput{TargetSID: aliceSID, Kind: "team", Message: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if event := readEvent(); !strings.Contains(event, second.ID) {
		t.Fatalf("post-publish feed event = %q", event)
	}
	// Client disconnect must release the subscription; a later publish to the
	// abandoned subscriber channel must not block or panic.
	cancel()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := reader.ReadString('\n'); err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stream did not close after client disconnect")
		}
	}
	if _, err := notices.Publish(ctx, contracts.NotificationInput{TargetSID: aliceSID, Kind: "team", Message: "after disconnect"}); err != nil {
		t.Fatal(err)
	}
}
