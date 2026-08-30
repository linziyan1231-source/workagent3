package store

import (
	"context"
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
}
