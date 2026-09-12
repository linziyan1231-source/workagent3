package credentialbroker

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"
)

type recoveryProtector struct {
	prefix string
	fail   string
}

func (p recoveryProtector) Seal(value []byte) ([]byte, error) {
	if string(value) == p.fail {
		return nil, errors.New("reseal failed")
	}
	return append([]byte(p.prefix), value...), nil
}
func (p recoveryProtector) Open(value []byte) ([]byte, error) {
	if !bytes.HasPrefix(value, []byte(p.prefix)) {
		return nil, errors.New("wrong identity")
	}
	return append([]byte(nil), value[len(p.prefix):]...), nil
}

func TestRecoveryRetainsLegacyFormatMetadataAndAtomicRollback(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "broker.db")
	old := recoveryProtector{prefix: "old:"}
	s, err := Open(path, old)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, id := range []string{"a", "b"} {
		if _, err := s.Put(ctx, Input{ID: id, Kind: KindProvider, Label: id, Secret: []byte(id), State: StateReady}); err != nil {
			t.Fatal(err)
		}
	}
	before, err := s.ListMetadata(ctx)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := ExportRecovery(ctx, path, old)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(backup)
	if string(backup) != `[{"ID":"a","Secret":"YQ=="},{"ID":"b","Secret":"Yg=="}]` {
		t.Fatal("legacy snapshot format changed")
	}
	if n, err := RecoveryCount(backup); err != nil || n != 2 {
		t.Fatalf("count=%d %v", n, err)
	}
	if err := RestoreRecovery(ctx, path, recoveryProtector{prefix: "new:", fail: "b"}, backup); err == nil {
		t.Fatal("expected reseal failure")
	}
	for _, id := range []string{"a", "b"} {
		if value, err := s.Resolve(ctx, id); err != nil || string(value) != id {
			t.Fatalf("rollback %s: %v", id, err)
		}
	}
	missing := []byte(`[{"ID":"a","Secret":"YQ=="},{"ID":"missing","Secret":"Yg=="}]`)
	if err := RestoreRecovery(ctx, path, recoveryProtector{prefix: "new:"}, missing); err == nil {
		t.Fatal("missing record accepted")
	}
	if _, err := s.Resolve(ctx, "a"); err != nil {
		t.Fatal("missing record did not roll back previous update")
	}
	for i := 0; i < 2; i++ {
		if err := RestoreRecovery(ctx, path, recoveryProtector{prefix: "new:"}, backup); err != nil {
			t.Fatal(err)
		}
	}
	s.protector = recoveryProtector{prefix: "new:"}
	for _, id := range []string{"a", "b"} {
		if value, err := s.Resolve(ctx, id); err != nil || string(value) != id {
			t.Fatalf("restored %s: %v", id, err)
		}
	}
	after, err := s.ListMetadata(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := range before {
		if before[i] != after[i] {
			t.Fatal("recovery changed metadata")
		}
	}
}

func TestRecoveryMissingDatabaseAndWrongIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.db")
	backup, err := ExportRecovery(t.Context(), path, recoveryProtector{prefix: "old:"})
	if err != nil || string(backup) != "[]" {
		t.Fatalf("missing=%s %v", backup, err)
	}
	s, err := Open(path, recoveryProtector{prefix: "old:"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Put(t.Context(), Input{ID: "a", Kind: KindProvider, Label: "A", Secret: []byte("a"), State: StateReady}); err != nil {
		t.Fatal(err)
	}
	if _, err := ExportRecovery(t.Context(), path, recoveryProtector{prefix: "new:"}); err == nil {
		t.Fatal("wrong identity exported")
	}
}
