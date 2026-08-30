package userhost

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"workagent3/internal/runtimeapi"
)

func TestHTTPLeaseReporterRoundTrip(t *testing.T) {
	registry := runtimeapi.NewRegistry()
	const sid = "S-1-5-21-1000"
	const credential = "registration-secret"
	if err := registry.Authorize(sid, credential); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(runtimeapi.LeaseHandler(registry))
	defer server.Close()
	reporter, err := NewHTTPLeaseReporter(server.URL, credential)
	if err != nil {
		t.Fatal(err)
	}
	registration := runtimeapi.Registration{SID: sid, BaseURL: "http://127.0.0.1:43123", Token: "runtime-token", ExpiresAt: time.Now()}
	if err := reporter.Publish(context.Background(), registration); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Resolve(context.Background(), sid); err != nil {
		t.Fatalf("published lease not resolved: %v", err)
	}
	if err := reporter.Remove(context.Background(), registration); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Resolve(context.Background(), sid); err != runtimeapi.ErrRuntimeUnavailable {
		t.Fatalf("removed lease still resolved: %v", err)
	}
}
