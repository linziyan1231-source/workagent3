package professionaldb

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testProtector struct{}

func (testProtector) Seal(value []byte) ([]byte, error) {
	result := append([]byte("sealed:"), value...)
	for index := 7; index < len(result); index++ {
		result[index] ^= 0xa5
	}
	return result, nil
}
func (testProtector) Open(value []byte) ([]byte, error) {
	if !strings.HasPrefix(string(value), "sealed:") {
		return nil, errors.New("unsealed")
	}
	result := append([]byte(nil), value[7:]...)
	for index := range result {
		result[index] ^= 0xa5
	}
	return result, nil
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "professional.db"), testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func testGrant(t *testing.T, s *Store, sid string, daily, monthly int) string {
	t.Helper()
	_, err := s.SetGrant(context.Background(), sid, Grant{Enabled: true, AllowedSources: []string{"wind", "arxiv"}, DailyLimit: daily, MonthlyLimit: monthly})
	if err != nil {
		t.Fatal(err)
	}
	token, err := s.IssueToken(context.Background(), sid)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestConcurrentReservationNeverExceedsQuota(t *testing.T) {
	s := newTestStore(t)
	token := testGrant(t, s, "S-1-5-21-1", 17, 17)
	var successes atomic.Int64
	var group sync.WaitGroup
	for range 80 {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := s.reserve(context.Background(), token, "wind", "call_data_source_tool")
			if err == nil {
				successes.Add(1)
			} else if !errors.Is(err, ErrDailyExceeded) {
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	group.Wait()
	grant, err := s.Grant(context.Background(), "S-1-5-21-1")
	if err != nil || successes.Load() != 17 || grant.DailyUsed != 17 || grant.MonthlyUsed != 17 {
		t.Fatalf("successful calls=%d grant=%+v error=%v", successes.Load(), grant, err)
	}
	var ledger int
	if err = s.db.QueryRow(`SELECT COUNT(*) FROM professional_database_calls`).Scan(&ledger); err != nil || ledger != 17 {
		t.Fatalf("ledger=%d error=%v", ledger, err)
	}
}

func TestQuotaCalendarRestartLimitsAndRevocation(t *testing.T) {
	ctx := context.Background()
	file := filepath.Join(t.TempDir(), "professional.db")
	s, err := Open(file, testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 29, 15, 59, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	token := testGrant(t, s, "S-1-5-21-2", 2, 3)
	for range 2 {
		if _, err = s.reserve(ctx, token, "wind", "get_data_source_desc"); err != nil {
			t.Fatal(err)
		}
	}
	now = now.Add(2 * time.Minute) // Midnight in China; still the previous UTC day.
	g, err := s.Grant(ctx, "S-1-5-21-2")
	if err != nil || g.DailyUsed != 0 || g.MonthlyUsed != 2 {
		t.Fatalf("China date boundary: %+v %v", g, err)
	}
	if _, err = s.reserve(ctx, token, "wind", "call_data_source_tool"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.reserve(ctx, token, "wind", "call_data_source_tool"); !errors.Is(err, ErrMonthlyExceeded) {
		t.Fatalf("monthly limit: %v", err)
	}
	s.Close()
	s, err = Open(file, testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.now = func() time.Time { return now }
	stable, err := s.IssueToken(ctx, "S-1-5-21-2")
	if err != nil || stable != token {
		t.Fatal("token changed after restart")
	}
	g, err = s.Grant(ctx, "S-1-5-21-2")
	if err != nil || g.DailyUsed != 1 || g.MonthlyUsed != 3 {
		t.Fatalf("restart usage: %+v %v", g, err)
	}
	g.DailyUsed = 0
	g.MonthlyUsed = 0
	g.DailyLimit = 3
	g.MonthlyLimit = 4
	g, err = s.SetGrant(ctx, "S-1-5-21-2", g)
	if err != nil || g.MonthlyUsed != 3 {
		t.Fatalf("limit change reset usage: %+v %v", g, err)
	}
	g.Enabled = false
	if _, err = s.SetGrant(ctx, "S-1-5-21-2", g); err != nil {
		t.Fatal(err)
	}
	if _, err = s.reserve(ctx, token, "wind", "call_data_source_tool"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("revocation: %v", err)
	}
	g.Enabled = true
	g.AllowedSources = []string{"arxiv"}
	if _, err = s.SetGrant(ctx, "S-1-5-21-2", g); err != nil {
		t.Fatal(err)
	}
	if _, err = s.reserve(ctx, token, "wind", "call_data_source_tool"); !errors.Is(err, ErrSourceDenied) {
		t.Fatalf("source revocation: %v", err)
	}
	now = time.Date(2026, 9, 30, 16, 1, 0, 0, time.UTC)
	g, err = s.Grant(ctx, "S-1-5-21-2")
	if err != nil || g.DailyUsed != 0 || g.MonthlyUsed != 0 {
		t.Fatalf("month boundary: %+v %v", g, err)
	}
}

func TestTokensAndUsageAreSeparatedByEmployee(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	a := testGrant(t, s, "S-1-5-21-10", 2, 3)
	b := testGrant(t, s, "S-1-5-21-11", 2, 3)
	if a == b {
		t.Fatal("shared token")
	}
	_, aSecret, _ := strings.Cut(a, ".")
	for _, bad := range []string{"", "S-1-5-21-11." + aSecret, a + "x", "unknown." + aSecret} {
		if _, _, err := s.authenticate(ctx, s.db, bad, s.now()); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("invalid token accepted: %v", err)
		}
	}
	if _, err := s.reserve(ctx, a, "wind", "get_data_source_desc"); err != nil {
		t.Fatal(err)
	}
	g, _ := s.Grant(ctx, "S-1-5-21-11")
	if g.DailyUsed != 0 || g.MonthlyUsed != 0 {
		t.Fatal("cross-user usage")
	}
	var sealed []byte
	if err := s.db.QueryRow(`SELECT sealed_token FROM professional_database_grants WHERE sid=?`, "S-1-5-21-10").Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(sealed), aSecret) {
		t.Fatal("token stored as plaintext")
	}
	for _, source := range []string{"unknown", "caixin"} {
		if _, err := s.reserve(ctx, a, source, "get_data_source_desc"); !errors.Is(err, ErrSourceDenied) {
			t.Fatalf("source=%s error=%v", source, err)
		}
	}
	g, _ = s.Grant(ctx, "S-1-5-21-10")
	if g.DailyUsed != 1 {
		t.Fatal("denied calls consumed quota")
	}
}

func TestZeroQuotaAndGrantValidation(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	token := testGrant(t, s, "S-1-5-21-9", 0, 0)
	if _, err := s.reserve(ctx, token, "wind", "call_data_source_tool"); !errors.Is(err, ErrDailyExceeded) {
		t.Fatalf("zero quota: %v", err)
	}
	for index, grant := range []Grant{
		{Enabled: true, AllowedSources: []string{"invented"}, DailyLimit: 1, MonthlyLimit: 1},
		{Enabled: true, DailyLimit: 1, MonthlyLimit: 1},
		{DailyLimit: -1, MonthlyLimit: 1}, {DailyLimit: 2, MonthlyLimit: 1}, {DailyLimit: 10001, MonthlyLimit: 100000}, {MonthlyLimit: 100001},
	} {
		if _, err := s.SetGrant(ctx, fmt.Sprintf("invalid-%d", index), grant); err == nil {
			t.Fatalf("invalid grant accepted: %+v", grant)
		}
	}
}
