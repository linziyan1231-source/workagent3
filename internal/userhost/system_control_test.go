package userhost

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"workagent3/internal/mcpruntime"
)

func TestRuntimeSystemStatusAndRestartAreAuthenticatedAndReal(t *testing.T) {
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	harness := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/health" || request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Fatalf("unexpected health request: %s %#v", request.URL.Path, request.Header)
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer harness.Close()
	target, _ := url.Parse(harness.URL)
	restarted := make(chan struct{}, 1)
	handler := newRuntimeGatewayHandlerWithControl(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, openGatewaySkills(t), gatewayTestPublisher{}, nil, nil, target, "runtime-token", nil, nil, nil, "", func() { restarted <- struct{}{} }, nil, nil, "")

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/system/status", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", unauthorized.Code)
	}
	statusRequest := httptest.NewRequest(http.MethodGet, "/v1/system/status", nil)
	statusRequest.Header.Set("Authorization", "Bearer runtime-token")
	status := httptest.NewRecorder()
	handler.ServeHTTP(status, statusRequest)
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"id":"userhost","status":"healthy"`) || !strings.Contains(status.Body.String(), `"id":"harness","status":"healthy"`) {
		t.Fatalf("status=%d body=%s", status.Code, status.Body.String())
	}
	restartRequest := httptest.NewRequest(http.MethodPost, "/v1/system/restart", nil)
	restartRequest.Header.Set("Authorization", "Bearer runtime-token")
	restart := httptest.NewRecorder()
	handler.ServeHTTP(restart, restartRequest)
	if restart.Code != http.StatusAccepted {
		t.Fatalf("restart=%d body=%s", restart.Code, restart.Body.String())
	}
	select {
	case <-restarted:
	case <-time.After(time.Second):
		t.Fatal("restart signal was not delivered")
	}
}
