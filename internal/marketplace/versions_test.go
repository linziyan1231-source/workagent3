package marketplace

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestVersionChoicesAndProjectPinsSurviveReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "market.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	publish := func(id, version string) Entry {
		t.Helper()
		e := Entry{ID: id, Name: "Review", Kind: "skill", Version: version, Publisher: "alice", ReleaseNotes: "说明 " + version}
		if err := s.Publish(ctx, e, Bundle{}); err != nil {
			t.Fatal(err)
		}
		e, _, err := s.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	first := publish("release-one", "1.2.0")
	state := Installation{Skills: map[string]string{"source": "installed-old"}, MCP: map[string]string{}, Complete: true}
	if err = s.SaveInstallation(ctx, "employee", first.ID, state); err != nil {
		t.Fatal(err)
	}
	if err = s.Select(ctx, "employee", first); err != nil {
		t.Fatal(err)
	}
	if err = s.Subscribe(ctx, "project", first); err != nil {
		t.Fatal(err)
	}
	latest := publish("release-two", "1.10.0")
	// Merely preparing a newer snapshot (or installing it for a project) is not a personal update.
	if err = s.SaveInstallation(ctx, "employee", latest.ID, state); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveInstallation(ctx, "project-only", latest.ID, state); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rows, err := s.Catalog(ctx, "bob", "employee")
	if err != nil || len(rows) != 1 || rows[0].ID != latest.ID || !rows[0].UpdateAvailable || rows[0].InstalledVersion != "1.2.0" {
		t.Fatalf("catalog: %+v %v", rows, err)
	}
	if _, _, err = s.Selection(ctx, "project-only", latest.SeriesID); !errors.Is(err, ErrNotFound) {
		t.Fatal("project installation became personal selection", err)
	}
	pins, _ := s.Subscriptions(ctx, "project")
	if len(pins) != 1 || pins[0].EntryID != first.ID {
		t.Fatal("new publication changed a project pin", pins)
	}
	if err = s.Unpublish(ctx, first.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.Get(ctx, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("withdrawn version remains discoverable")
	}
	if e, _, err := s.Snapshot(ctx, first.ID); err != nil || e.ReleaseNotes != "说明 1.2.0" {
		t.Fatal("withdrawal lost installed snapshot", err)
	}
	if err = s.Publish(ctx, Entry{ID: "impostor", SeriesID: first.SeriesID, Name: "Review", Kind: "skill", Version: "2.0.0", Publisher: "bob"}, Bundle{}); !errors.Is(err, ErrForbidden) {
		t.Fatal("other author changed lineage", err)
	}
}

func TestEmergencyRevocationSupersedesOfflineUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "market.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	for _, e := range []Entry{{ID: "release-old", Name: "Skill", Publisher: "author", Version: "1.0.0", Kind: "skill"}, {ID: "release-new", Name: "Skill", Publisher: "author", Version: "2.0.0", Kind: "skill"}} {
		if err = s.Publish(ctx, e, Bundle{}); err != nil {
			t.Fatal(err)
		}
	}
	old, _, _ := s.Get(ctx, "release-old")
	next, _, _ := s.Get(ctx, "release-new")
	s.Subscribe(ctx, "project", old)
	first := Action{ID: "first", SeriesID: old.SeriesID, TargetID: next.ID, Action: "update", Reason: "patch", Actor: "admin", Targets: []ActionTarget{{SID: "offline"}, {SID: "administrator"}}}
	if err = s.CreateAction(ctx, first); err != nil {
		t.Fatal(err)
	}
	second := Action{ID: "second", SeriesID: old.SeriesID, Action: "delete", Reason: "revoke", Actor: "admin", Targets: first.Targets}
	if err = s.CreateAction(ctx, second); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	actions, err := s.Actions(ctx)
	if err != nil || len(actions) != 2 {
		t.Fatal(err, actions)
	}
	for _, a := range actions {
		for _, target := range a.Targets {
			want := "pending"
			if a.ID == "first" {
				want = "superseded"
			}
			if target.State != want {
				t.Fatalf("%+v", a)
			}
		}
	}
	if versions, _ := s.Versions(ctx, old.SeriesID, false); len(versions) != 0 {
		t.Fatal("revoked versions remain installable")
	}
	if err = s.ApplyProjectAction(ctx, second); err != nil {
		t.Fatal(err)
	}
	if pins, _ := s.Subscriptions(ctx, "project"); len(pins) != 0 {
		t.Fatal("revoked subscription remains")
	}
}

func TestMigrationAdoptsOnlyPreexistingCompletedInstallation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "market.db")
	s, _ := Open(path)
	e := Entry{ID: "old-entry", Name: "old", Kind: "skill", Version: "1.0.0", Publisher: "alice"}
	if err := s.Publish(t.Context(), e, Bundle{}); err != nil {
		t.Fatal(err)
	}
	s.SaveInstallation(t.Context(), "legacy-user", e.ID, Installation{Complete: true})
	if _, err := s.db.Exec(`DROP TABLE marketplace_selections`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if selected, _, err := s.Selection(t.Context(), "legacy-user", e.ID); err != nil || selected.ID != e.ID {
		t.Fatal("migration failed", selected, err)
	}
}

func TestAdminUnlistControlsNewVersionsUntilRelist(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "market.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	publish := func(id, version string) {
		t.Helper()
		if err := s.Publish(ctx, Entry{ID: id, Name: "Review", Kind: "skill", Version: version, Publisher: "alice", DefaultEnabled: true}, Bundle{}); err != nil {
			t.Fatal(err)
		}
	}
	publish("release-one", "1.0.0")
	e, _, err := s.Get(ctx, "release-one")
	if err != nil || !e.DefaultEnabled || !e.Listed {
		t.Fatalf("new fields did not round-trip: %+v %v", e, err)
	}
	if snap, _, err := s.Snapshot(ctx, "release-one"); err != nil || !snap.DefaultEnabled || !snap.Listed {
		t.Fatalf("snapshot lost new fields: %+v %v", snap, err)
	}
	series := e.SeriesID
	action := func(id, name string) {
		t.Helper()
		if err := s.CreateAction(ctx, Action{ID: id, SeriesID: series, Action: name, Reason: "policy", Actor: "admin", Targets: []ActionTarget{}}); err != nil {
			t.Fatal(err)
		}
	}
	action("action-1-unlist", "unlist")
	if _, _, err = s.Get(ctx, "release-one"); !errors.Is(err, ErrNotFound) {
		t.Fatal("unlisted version remains installable")
	}
	publish("release-two", "2.0.0")
	versions, err := s.Versions(ctx, series, true)
	if err != nil || len(versions) != 2 {
		t.Fatal(err, versions)
	}
	for _, v := range versions {
		if v.Listed {
			t.Fatal("new version bypassed admin unlist", v)
		}
	}
	if rows, _ := s.Catalog(ctx, "bob", "employee"); len(rows) != 0 {
		t.Fatal("unlisted series remains in catalog")
	}
	action("action-2-relist", "relist")
	if e, _, err = s.Get(ctx, "release-two"); err != nil || !e.Listed || !e.DefaultEnabled {
		t.Fatal("relist did not restore listing", e, err)
	}
	// An author's own withdrawal is not an administrative hold and must not block new versions.
	if err = s.Unpublish(ctx, "release-one", "alice"); err != nil {
		t.Fatal(err)
	}
	publish("release-three", "3.0.0")
	if e, _, err = s.Get(ctx, "release-three"); err != nil || !e.Listed {
		t.Fatal("author unpublish blocked a new version", e, err)
	}
}
