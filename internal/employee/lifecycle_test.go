package employee

import (
	"context"
	"errors"
	"testing"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/store"
)

type lifecyclePlatform struct {
	starts   int
	stops    int
	startErr error
	stopErr  error
}

type failingEnableStore struct{ *store.Store }

func (s failingEnableStore) SetUserEnabled(ctx context.Context, username string, enabled bool) error {
	if enabled {
		return errors.New("database unavailable")
	}
	return s.Store.SetUserEnabled(ctx, username, enabled)
}

func (p *lifecyclePlatform) StartInstalledRuntime(context.Context, string) error {
	p.starts++
	return p.startErr
}
func (p *lifecyclePlatform) StopInstalledRuntime(context.Context, string) error {
	p.stops++
	return p.stopErr
}

func TestLifecycleDisableRevokesSessionsBeforeRuntimeStop(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "old-hash")
	if err := data.CreateSession(t.Context(), "active", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{stopErr: errors.New("task unavailable")}
	result, err := (Lifecycle{Platform: platform, Users: data}).SetEnabled(t.Context(), "alice", false)
	if err == nil || !result.Disabled || platform.stops != 1 {
		t.Fatalf("disable did not fail closed: result=%+v err=%v", result, err)
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled {
		t.Fatal("Portal account was re-enabled after runtime stop failure")
	}
	if _, err := data.UserBySession(t.Context(), "active", time.Now()); err == nil {
		t.Fatal("existing browser session survived employee disable")
	}
}

func TestLifecycleEnableRequiresHealthyRuntime(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{startErr: errors.New("not healthy")}
	if _, err := (Lifecycle{Platform: platform, Users: data}).SetEnabled(t.Context(), "alice", true); err == nil {
		t.Fatal("unhealthy runtime enabled the employee")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled || platform.starts != 1 {
		t.Fatalf("employee was not kept disabled: %+v", stored)
	}
	platform.startErr = nil
	result, err := (Lifecycle{Platform: platform, Users: data}).SetEnabled(t.Context(), "alice", true)
	if err != nil || result.Disabled {
		t.Fatalf("healthy runtime did not enable employee: result=%+v err=%v", result, err)
	}
}

func TestLifecycleStopsRuntimeWhenEnableCommitFails(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{}
	_, err := (Lifecycle{Platform: platform, Users: failingEnableStore{data}}).SetEnabled(t.Context(), "alice", true)
	if err == nil || platform.starts != 1 || platform.stops != 1 {
		t.Fatalf("enable rollback did not stop Runtime: starts=%d stops=%d err=%v", platform.starts, platform.stops, err)
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled {
		t.Fatal("failed enable commit opened the Portal account")
	}
}

func TestLifecyclePasswordResetRevokesSessions(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "old-hash")
	_ = data.CreateSession(t.Context(), "active", user.ID, time.Now().Add(time.Hour))
	password := []byte("replacement portal password")
	if err := (Lifecycle{Users: data}).ResetPortalPassword(t.Context(), "alice", password); err != nil {
		t.Fatal(err)
	}
	if string(password) != string(make([]byte, len(password))) {
		t.Fatal("caller password buffer was not cleared")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !auth.VerifyPassword(stored.PasswordHash, []byte("replacement portal password")) {
		t.Fatal("new Portal password was not stored")
	}
	if _, err := data.UserBySession(t.Context(), "active", time.Now()); err == nil {
		t.Fatal("existing browser session survived password reset")
	}
}
