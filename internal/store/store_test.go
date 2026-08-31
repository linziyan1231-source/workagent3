package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionResolvesSIDBoundUser(t *testing.T) {
	data, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	ctx := context.Background()
	user, err := data.CreateUser(ctx, "alice", "S-1-5-21-1000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(ctx, "token", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	resolved, err := data.UserBySession(ctx, "token", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if resolved.SID != "S-1-5-21-1000" {
		t.Fatalf("resolved SID %q", resolved.SID)
	}
	if resolved.CreatedAt.IsZero() || resolved.LastLoginAt == nil {
		t.Fatalf("employee lifecycle timestamps were not persisted: %+v", resolved)
	}
}

func TestRuntimeRegistrationCredentialSurvivesPortalRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "portal.db")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.AuthorizeRuntime(t.Context(), "S-1-5-21-1000", "registration-secret"); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if !second.RuntimeRegistrationAuthorized(t.Context(), "S-1-5-21-1000", "registration-secret") {
		t.Fatal("persisted credential was not authorized after restart")
	}
	if second.RuntimeRegistrationAuthorized(t.Context(), "S-1-5-21-2000", "registration-secret") ||
		second.RuntimeRegistrationAuthorized(t.Context(), "S-1-5-21-1000", "wrong-secret") {
		t.Fatal("runtime credential was not scoped to the exact SID and secret")
	}
}

func TestAdministratorRoleChangeRevokesSessions(t *testing.T) {
	data, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(t.Context(), "token", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := data.SetUserAdmin(t.Context(), user.Username, true); err != nil {
		t.Fatal(err)
	}
	updated, err := data.UserByUsername(t.Context(), user.Username)
	if err != nil || !updated.Admin {
		t.Fatalf("administrator role was not stored: %+v, %v", updated, err)
	}
	if _, err := data.UserBySession(t.Context(), "token", time.Now()); err == nil {
		t.Fatal("browser session survived administrator role change")
	}
}
