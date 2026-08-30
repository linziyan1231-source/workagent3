package runtimeapi

import (
	"context"
	"testing"
	"time"
)

func TestRegistryAcceptsOnlyLoopbackRuntime(t *testing.T) {
	registry := NewRegistry()
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	registry.now = func() time.Time { return now }
	if err := registry.Register(Registration{SID: "S-1-5-21-1000", BaseURL: "http://127.0.0.1:43123", Token: "secret", ExpiresAt: now.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	endpoint, err := registry.Resolve(context.Background(), "S-1-5-21-1000")
	if err != nil || endpoint.BaseURL.Port() != "43123" {
		t.Fatalf("resolve: endpoint=%+v err=%v", endpoint, err)
	}
	if err := registry.Register(Registration{SID: "S-1-5-21-2000", BaseURL: "http://192.0.2.1:80", Token: "secret", ExpiresAt: now.Add(time.Minute)}); err == nil {
		t.Fatal("accepted a non-loopback runtime")
	}
}

func TestRegistryExpiresAndTokenGuardsRemoval(t *testing.T) {
	registry := NewRegistry()
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	registry.now = func() time.Time { return now }
	registration := Registration{SID: "S-1-5-21-1000", BaseURL: "http://[::1]:43123", Token: "secret", ExpiresAt: now.Add(time.Minute)}
	if err := registry.Register(registration); err != nil {
		t.Fatal(err)
	}
	registry.Remove(registration.SID, "wrong-token")
	if _, err := registry.Resolve(context.Background(), registration.SID); err != nil {
		t.Fatal("wrong token removed runtime")
	}
	now = now.Add(2 * time.Minute)
	if _, err := registry.Resolve(context.Background(), registration.SID); !errorsIs(err, ErrRuntimeUnavailable) {
		t.Fatalf("expired resolve error: %v", err)
	}
}

func errorsIs(actual, target error) bool {
	return actual == target
}
