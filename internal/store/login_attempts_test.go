package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestLoginLimitsPersistAndSuccessDoesNotResetIP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	p := DefaultLoginPolicy()
	p.IPLimit = 6
	for i := 0; i < 5; i++ {
		if err := s.RecordLoginAttempt(t.Context(), "Alice", "192.0.2.1", false, now, p); err != nil {
			t.Fatal(err)
		}
	}
	until, err := s.LoginBlockedUntil(t.Context(), "ALICE", "192.0.2.2", now)
	if err != nil || !until.Equal(now.Add(p.Lockout)) {
		t.Fatalf("account lock: %v %v", until, err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	until, err = s.LoginBlockedUntil(t.Context(), "alice", "192.0.2.2", now)
	if err != nil || until.IsZero() {
		t.Fatal("restart lost lock", err)
	}
	if err = s.RecordLoginAttempt(t.Context(), "bob", "192.0.2.1", true, now, p); err != nil {
		t.Fatal(err)
	}
	if err = s.RecordLoginAttempt(t.Context(), "carol", "192.0.2.1", false, now, p); err != nil {
		t.Fatal(err)
	}
	until, err = s.LoginBlockedUntil(t.Context(), "dave", "192.0.2.1", now)
	if err != nil || until.IsZero() {
		t.Fatal("success cleared IP attempts", err)
	}
	if err = s.RecordLoginAttempt(t.Context(), "alice", "192.0.2.2", false, now.Add(time.Minute), p); err != nil {
		t.Fatal(err)
	}
	until, _ = s.LoginBlockedUntil(t.Context(), "alice", "192.0.2.3", now)
	if !until.Equal(now.Add(p.Lockout)) {
		t.Fatal("blocked request extended lock")
	}
	until, err = s.LoginBlockedUntil(t.Context(), "alice", "192.0.2.1", now.Add(p.Lockout))
	if err != nil || !until.IsZero() {
		t.Fatal("lock did not expire", err)
	}
}
