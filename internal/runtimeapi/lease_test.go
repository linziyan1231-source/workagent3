package runtimeapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLeaseHandlerScopesCredentialToSID(t *testing.T) {
	registry := NewRegistry()
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	registry.now = func() time.Time { return now }
	if err := registry.Authorize("S-1-5-21-1000", "alice-registration-secret"); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPut, "/internal/runtime/lease", strings.NewReader(`{"sid":"S-1-5-21-2000","baseUrl":"http://127.0.0.1:43123","token":"runtime-secret"}`))
	request.RemoteAddr = "127.0.0.1:55000"
	request.Header.Set("Authorization", "Bearer alice-registration-secret")
	response := httptest.NewRecorder()
	LeaseHandler(registry, registry).ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("cross-SID lease returned %d: %s", response.Code, response.Body.String())
	}
	if _, err := registry.Resolve(context.Background(), "S-1-5-21-2000"); err != ErrRuntimeUnavailable {
		t.Fatalf("unauthorized runtime was registered: %v", err)
	}
}

func TestLeaseHandlerPublishesRenewsAndRemovesRuntime(t *testing.T) {
	registry := NewRegistry()
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	registry.now = func() time.Time { return now }
	const sid = "S-1-5-21-1000"
	const credential = "registration-secret"
	if err := registry.Authorize(sid, credential); err != nil {
		t.Fatal(err)
	}

	invoke := func(method string) int {
		request := httptest.NewRequest(method, "/internal/runtime/lease", strings.NewReader(`{"sid":"`+sid+`","baseUrl":"http://127.0.0.1:43123","token":"runtime-secret"}`))
		request.RemoteAddr = "[::1]:55000"
		request.Header.Set("Authorization", "Bearer "+credential)
		response := httptest.NewRecorder()
		LeaseHandler(registry, registry).ServeHTTP(response, request)
		return response.Code
	}
	if status := invoke(http.MethodPut); status != http.StatusNoContent {
		t.Fatalf("publish status %d", status)
	}
	now = now.Add(DefaultLeaseDuration - time.Second)
	if status := invoke(http.MethodPut); status != http.StatusNoContent {
		t.Fatalf("renew status %d", status)
	}
	now = now.Add(2 * time.Second)
	if _, err := registry.Resolve(context.Background(), sid); err != nil {
		t.Fatalf("renewed runtime expired: %v", err)
	}
	if status := invoke(http.MethodDelete); status != http.StatusNoContent {
		t.Fatalf("remove status %d", status)
	}
	if _, err := registry.Resolve(context.Background(), sid); err != ErrRuntimeUnavailable {
		t.Fatalf("removed runtime still resolves: %v", err)
	}
}

func TestLeaseHandlerRejectsNonLoopbackCaller(t *testing.T) {
	registry := NewRegistry()
	request := httptest.NewRequest(http.MethodPut, "/internal/runtime/lease", strings.NewReader(`{}`))
	request.RemoteAddr = "192.0.2.20:55000"
	response := httptest.NewRecorder()
	LeaseHandler(registry, registry).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-loopback request returned %d", response.Code)
	}
}

func TestLeaseStatusIsScopedAndReportsAvailability(t *testing.T) {
	registry := NewRegistry()
	const sid = "S-1-5-21-1000"
	if err := registry.Authorize(sid, "registration-secret"); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/internal/runtime/lease?sid="+sid, nil)
	request.RemoteAddr = "127.0.0.1:55000"
	request.Header.Set("Authorization", "Bearer registration-secret")
	response := httptest.NewRecorder()
	LeaseHandler(registry, registry).ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing runtime status %d", response.Code)
	}
	if err := registry.Register(Registration{SID: sid, BaseURL: "http://127.0.0.1:43123", Token: "runtime-secret", ExpiresAt: time.Now().Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/internal/runtime/lease?sid="+sid, nil)
	request.RemoteAddr = "127.0.0.1:55000"
	request.Header.Set("Authorization", "Bearer registration-secret")
	LeaseHandler(registry, registry).ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("healthy runtime status %d: %s", response.Code, response.Body.String())
	}
}
