package publishedapps

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestApplicationsFreezeOwnershipAndAllocatePermanentPorts(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "apps.db"), 21000, 21003)
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
