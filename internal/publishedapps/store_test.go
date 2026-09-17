package publishedapps

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestApplicationsFreezeOwnershipAndAllocatePermanentPorts(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "apps.db"), 21000, 21003, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "project", Name: "demo", Kind: "static", Entry: "site/index.html", Enabled: true, Version: "forged"})
	if err != nil {
		t.Fatal(err)
	}
	if a.Enabled || a.Version != "" || a.Port != 21000 || a.PreviewPort != 21001 {
		t.Fatal(a)
	}
	saved, err := s.Get(t.Context(), a.ID)
	if err != nil || saved.OwnerSID != "S-1-a" {
		t.Fatal("owner lost", err)
	}
	a.Enabled = true
	a.Access = "members"
	a.Members = []int64{2}
	a.Version = "v1"
	updated, err := s.Update(t.Context(), a, a.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Allows(2, false) || updated.Allows(3, false) || updated.Allows(0, false) || updated.Allows(2, true) {
		t.Fatal("access scope")
	}
	if _, err = s.Update(t.Context(), a, a.Revision); err == nil {
		t.Fatal("stale update accepted")
	}
	a.ID = ""
	second, err := s.Create(t.Context(), a)
	if err != nil || second.Port != 21002 {
		t.Fatal(err)
	}
	if _, err = s.Create(t.Context(), a); !errors.Is(err, ErrPorts) {
		t.Fatal(err)
	}
}
func TestApplicationPathsAndOrigins(t *testing.T) {
	base := App{WorkspaceID: "p", Name: "a", Kind: "node", Entry: "server.js"}
	for _, entry := range []string{"../secret", "C:/secret", "/secret", "x/../../secret", "a\\b"} {
		a := base
		a.Entry = entry
		if Validate(a) == nil {
			t.Fatal(entry)
		}
	}
	for _, origin := range []string{"file:///tmp", "https://u:p@example.com", "https://example.com/path", "https://example.com?q=1"} {
		a := base
		a.AllowedOrigins = []string{origin}
		if Validate(a) == nil {
			t.Fatal(origin)
		}
	}
}
func TestApplicationExpiryAccessModesAndDelete(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "apps.db"), 21100, 21103, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-b", WorkspaceID: "default", Name: "site", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	a.Enabled = true
	a.Version = "v1"
	a.Access = "token"
	a.ShareToken = "share"
	a.ExpiresAt = time.Now().Add(time.Hour)
	updated, err := s.Update(t.Context(), a, a.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Allows(0, false) {
		t.Fatal("token mode allows anonymous without grant")
	}
	a = updated
	a.ExpiresAt = time.Now().Add(-time.Hour)
	updated, err = s.Update(t.Context(), a, a.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Allows(updated.OwnerID, false) || !updated.Expired(time.Now()) {
		t.Fatal("expired app still allows")
	}
	if !updated.Allows(updated.OwnerID, true) {
		t.Fatal("owner preview blocked by expiry")
	}
	a = updated
	a.Access = "password"
	a.Password = "12345678"
	if _, err = s.Update(t.Context(), a, a.Revision); err != nil {
		t.Fatal("password access rejected", err)
	}
	a.Access = "bogus"
	if _, err = s.Update(t.Context(), a, a.Revision); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid access accepted", err)
	}
	if err = s.Delete(t.Context(), updated.ID, "S-1-other"); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign delete", err)
	}
	if err = s.Delete(t.Context(), updated.ID, "S-1-b"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get(t.Context(), updated.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("deleted app still visible", err)
	}
	rows, err := s.List(t.Context(), "")
	if err != nil || len(rows) != 0 {
		t.Fatal(rows, err)
	}
}
func TestDeleteReclaimsPortsForReuse(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "apps.db"), 21200, 21203, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	first, err := s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "one", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "two", Kind: "static", Entry: "index.html"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Delete(t.Context(), first.ID, "S-1-a"); err != nil {
		t.Fatal(err)
	}
	third, err := s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "three", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal("reclaimed ports not reusable", err)
	}
	if third.Port != 21200 || third.PreviewPort != 21201 {
		t.Fatal("expected lowest free pair after delete", third.Port, third.PreviewPort)
	}
	used, byOwner, err := s.PortUsage(t.Context())
	if err != nil || used != 4 || byOwner["S-1-a"] != 2 {
		t.Fatal(used, byOwner, err)
	}
}

func TestEmployeePortQuota(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "apps.db"), 21300, 21309, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := range 2 {
		if _, err = s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "app", Kind: "static", Entry: "index.html"}); err != nil {
			t.Fatal(i, err)
		}
	}
	if _, err = s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "app", Kind: "static", Entry: "index.html"}); !errors.Is(err, ErrEmployeePorts) {
		t.Fatal("quota not enforced", err)
	}
	// Another owner is unaffected, and deleting one app frees the quota.
	if _, err = s.Create(t.Context(), App{OwnerID: 2, OwnerSID: "S-1-b", WorkspaceID: "p", Name: "app", Kind: "static", Entry: "index.html"}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.List(t.Context(), "S-1-a")
	if err != nil || len(rows) != 2 {
		t.Fatal(rows, err)
	}
	if err = s.Delete(t.Context(), rows[0].ID, "S-1-a"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "app", Kind: "static", Entry: "index.html"}); err != nil {
		t.Fatal("quota slot not freed after delete", err)
	}
}

func TestSetRangeRemapsExistingAppsAndPersists(t *testing.T) {
	file := filepath.Join(t.TempDir(), "apps.db")
	s, err := Open(file, 21400, 21409, 3)
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "one", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "two", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	// Too small to hold the existing apps.
	if _, err = s.SetRange(t.Context(), 21500, 21502); !errors.Is(err, ErrPorts) {
		t.Fatal("undersized range accepted", err)
	}
	changed, err := s.SetRange(t.Context(), 21500, 21509)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 2 {
		t.Fatal("both apps should move", changed)
	}
	for id, port := range map[string]int{a.ID: 21500, b.ID: 21502} {
		saved, err := s.Get(t.Context(), id)
		if err != nil || saved.Port != port || saved.PreviewPort != port+1 {
			t.Fatal(id, saved.Port, saved.PreviewPort, err)
		}
	}
	// New allocations stay inside the saved range.
	c, err := s.Create(t.Context(), App{OwnerID: 1, OwnerSID: "S-1-a", WorkspaceID: "p", Name: "three", Kind: "static", Entry: "index.html"})
	if err != nil || c.Port != 21504 {
		t.Fatal(c.Port, err)
	}
	if err = s.SetMaxEmployeePorts(t.Context(), 0); !errors.Is(err, ErrInvalid) {
		t.Fatal("zero quota accepted", err)
	}
	if err = s.SetMaxEmployeePorts(t.Context(), 4); err != nil {
		t.Fatal(err)
	}
	s.Close()
	// Saved settings win over flags on reopen.
	reopened, err := Open(file, 29900, 29909, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	first, last, max := reopened.Settings()
	if first != 21500 || last != 21509 || max != 4 {
		t.Fatal(first, last, max)
	}
	saved, err := reopened.Get(t.Context(), a.ID)
	if err != nil || saved.Port != 21500 {
		t.Fatal(saved.Port, err)
	}
}

func TestRandomAccessCode(t *testing.T) {
	seen := map[string]bool{}
	for range 20 {
		code, err := RandomAccessCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != 8 {
			t.Fatal(code)
		}
		for _, c := range code {
			if c < '0' || c > '9' {
				t.Fatal(code)
			}
		}
		seen[code] = true
	}
	if len(seen) < 15 {
		t.Fatal("codes not random enough", seen)
	}
}
