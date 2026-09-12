package chatforward

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func openLedger(t *testing.T) (*Store, int64, time.Time) {
	t.Helper()
	s, e := Open(filepath.Join(t.TempDir(), "chatforward.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	id, e := s.Subject(t.Context(), "S-1-5-21-101")
	if e != nil {
		t.Fatal(e)
	}
	return s, id, time.Date(2026, 9, 13, 15, 59, 0, 0, time.UTC)
}
func event(id, kind string) Event {
	return Event{EventID: id + "_" + kind, LogicalID: id, AttemptID: id, Kind: kind}
}
func TestDispatchCountsOnceAndNeverRefundsForFailure(t *testing.T) {
	s, subject, now := openLedger(t)
	id := "request_1234567890"
	r, e := s.Reserve(t.Context(), subject, id, id, "gpt-5-6-pro", now)
	if e != nil || !r.Allowed || r.Usage.Pending != 1 {
		t.Fatalf("reserve %#v %v", r, e)
	}
	dispatch := event(id, "dispatch")
	for range 3 {
		if e = s.ApplyEvent(t.Context(), subject, dispatch, now); e != nil {
			t.Fatal(e)
		}
	}
	settle := event(id, "settle")
	settle.Outcome = "failed"
	settle.UpstreamStatus = 503
	if e = s.ApplyEvent(t.Context(), subject, settle, now); e != nil {
		t.Fatal(e)
	}
	if e = s.ApplyEvent(t.Context(), subject, event(id, "cancel"), now); e != nil {
		t.Fatal(e)
	}
	u, e := s.Usage(t.Context(), "S-1-5-21-101", now)
	if e != nil || u.Used != 1 || u.Pending != 0 {
		t.Fatalf("usage %#v %v", u, e)
	}
	r, e = s.Reserve(t.Context(), subject, id, id, "gpt-5-6-pro", now)
	if e != nil || r.Allowed {
		t.Fatalf("duplicate released permission %#v %v", r, e)
	}
	settle.Outcome = "completed"
	if e = s.ApplyEvent(t.Context(), subject, settle, now); !errors.Is(e, ErrConflict) {
		t.Fatalf("changed duplicate: %v", e)
	}
}
func TestUnknownAndLateEvidenceStayInOriginalWeek(t *testing.T) {
	s, subject, now := openLedger(t)
	id := "request_1234567891"
	s.Reserve(t.Context(), subject, id, id, "gpt-5-6-pro", now)
	if e := s.ApplyEvent(t.Context(), subject, event(id, "unknown"), now); e != nil {
		t.Fatal(e)
	}
	u, _ := s.Usage(t.Context(), "S-1-5-21-101", now)
	if u.Unknown != 1 || u.Pending != 1 {
		t.Fatal(u)
	}
	if e := s.ApplyEvent(t.Context(), subject, event(id, "dispatch"), now.Add(2*time.Minute)); e != nil {
		t.Fatal(e)
	}
	old, _ := s.Usage(t.Context(), "S-1-5-21-101", now)
	next, _ := s.Usage(t.Context(), "S-1-5-21-101", now.Add(2*time.Minute))
	if old.Used != 1 || next.Used != 0 || next.WeekStart.Hour() != 0 {
		t.Fatalf("old=%#v next=%#v", old, next)
	}
}
func TestCancellationTombstoneBeatsLateReservationAndSIDIsolation(t *testing.T) {
	s, subject, now := openLedger(t)
	id := "request_1234567892"
	if e := s.ApplyEvent(t.Context(), subject, event(id, "cancel"), now); e != nil {
		t.Fatal(e)
	}
	r, e := s.Reserve(t.Context(), subject, id, id, "gpt-5-6-pro", now)
	if e != nil || r.Allowed {
		t.Fatalf("late permission %#v %v", r, e)
	}
	other, _ := s.Subject(t.Context(), "S-1-5-21-102")
	if e = s.ApplyEvent(t.Context(), other, event(id, "dispatch"), now); !errors.Is(e, ErrNotFound) {
		t.Fatal(e)
	}
	if e = s.ApplyEvent(t.Context(), subject, event(id, "dispatch"), now); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
}
func TestConcurrentLastSlotAcrossConnections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.db")
	a, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	b, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	ctx := context.Background()
	subject, _ := a.Subject(ctx, "S-1-5-21-103")
	a.SetLimit(ctx, "S-1-5-21-103", 1)
	var wg sync.WaitGroup
	accepted := make(chan bool, 2)
	for i, s := range []*Store{a, b} {
		wg.Go(func() {
			id := []string{"concurrent_12345678", "concurrent_12345679"}[i]
			r, e := s.Reserve(ctx, subject, id, id, "gpt-5-6-pro", time.Now())
			if e != nil {
				t.Error(e)
			}
			accepted <- r.Allowed
		})
	}
	wg.Wait()
	close(accepted)
	count := 0
	for ok := range accepted {
		if ok {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("accepted %d", count)
	}
}
func TestResolutionCannotRefundDispatchedAndSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.db")
	s, _ := Open(path)
	ctx := t.Context()
	subject, _ := s.Subject(ctx, "S-1-5-21-104")
	now := time.Now()
	id := "resolve_1234567890"
	s.Reserve(ctx, subject, id, id, "gpt-5-6-pro", now)
	s.ApplyEvent(ctx, subject, event(id, "unknown"), now)
	if e := s.Resolve(ctx, "S-1-5-21-104", id, "dispatched", "admin", "confirmed sent", now); e != nil {
		t.Fatal(e)
	}
	s.Close()
	s, _ = Open(path)
	defer s.Close()
	if e := s.Resolve(ctx, "S-1-5-21-104", id, "cancelled", "admin", "response failed", now); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	u, _ := s.Usage(ctx, "S-1-5-21-104", now)
	if u.Used != 1 {
		t.Fatal(u)
	}
}
