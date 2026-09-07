package employeesecrets

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type testProtector struct{ key byte }

func (p testProtector) Seal(b []byte) ([]byte, error) {
	r := append([]byte{p.key}, b...)
	for i := 1; i < len(r); i++ {
		r[i] ^= p.key
	}
	return r, nil
}
func (p testProtector) Open(b []byte) ([]byte, error) {
	if b[0] != p.key {
		return nil, errors.New("wrong identity")
	}
	r := append([]byte(nil), b[1:]...)
	for i := range r {
		r[i] ^= p.key
	}
	return r, nil
}
func TestPendingCredentialSurvivesRestartAndPortableRecovery(t *testing.T) {
	root := t.TempDir()
	v := New(root, testProtector{7})
	r := Record{SID: "S-1-5-21-1001", Username: "test", Password: []byte("original-secret"), Pending: []byte("pending-secret"), Phase: "prepared", BrokerBackup: []byte("private-model-key")}
	if err := v.Write(r.SID, r); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(root, r.SID+".sealed"))
	if bytes.Contains(data, r.Password) || bytes.Contains(data, r.BrokerBackup) {
		t.Fatal("plaintext persisted")
	}
	restarted := New(root, testProtector{7})
	loaded, err := restarted.Read(r.SID)
	if err != nil || !bytes.Equal(loaded.Pending, r.Pending) || loaded.Phase != "prepared" {
		t.Fatalf("journal lost: %v", err)
	}
	pass := []byte("separate long recovery passphrase")
	backup, err := v.Export(r.SID, pass)
	if err != nil {
		t.Fatal(err)
	}
	restored := New(t.TempDir(), testProtector{42})
	if err := restored.Import(r.SID, []byte("incorrect"), backup); err == nil {
		t.Fatal("bad pass accepted")
	}
	if err := restored.Import("S-1-5-21-1002", pass, backup); err == nil {
		t.Fatal("wrong SID accepted")
	}
	if err := restored.Import(r.SID, pass, backup); err != nil {
		t.Fatal(err)
	}
	after, err := restored.Read(r.SID)
	if err != nil || !bytes.Equal(after.BrokerBackup, r.BrokerBackup) {
		t.Fatal("recovery lost broker snapshot")
	}
	backup[len(backup)-1] ^= 1
	if err := restored.Import(r.SID, pass, backup); err == nil {
		t.Fatal("tampered backup accepted")
	}
}
