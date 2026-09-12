package skillruntime

import (
	"path/filepath"
	"testing"
)

func TestRevocationSurvivesRestartAndCannotBeReinstalled(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	writeSkillPackage(t, source)
	db := filepath.Join(root, "skills.db")
	installed := filepath.Join(root, "installed")
	s, err := Open(db, installed)
	if err != nil {
		t.Fatal(err)
	}
	input := InstallInput{Entry: Entry{ID: "market-version", Name: "Market skill", Source: "market", Version: "1.0.0", Enabled: true}, SourceDirectory: source}
	if _, err = s.InstallMarket(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	if err = s.RevokeMarket(t.Context(), input.Entry.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetEnabled(t.Context(), input.Entry.ID, true); err == nil {
		t.Fatal("revoked skill enabled")
	}
	if err = s.RevokeMarket(t.Context(), input.Entry.ID, true); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(db, installed)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.InstallMarket(t.Context(), input); err == nil {
		t.Fatal("revoked skill reinstalled after restart")
	}
}
