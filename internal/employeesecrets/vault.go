// Package employeesecrets holds service-owned Windows logon credentials.
// These secrets are never returned through the Portal or employee APIs.
package employeesecrets

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"workagent3/internal/credentialbroker"
)

var ErrMissing = errors.New("employee Windows credential is not managed; maintenance migration is required")

// Pending is written before changing Windows. Both passwords remain available
// until task registration and a fresh logon have succeeded.
type Record struct {
	Username     string `json:"username"`
	SID          string `json:"sid,omitempty"`
	Password     []byte `json:"password"`
	Pending      []byte `json:"pending,omitempty"`
	Phase        string `json:"phase,omitempty"`
	BrokerBackup []byte `json:"brokerBackup,omitempty"`
}

func (r *Record) Clear() { clear(r.Password); clear(r.Pending); clear(r.BrokerBackup) }

type Vault struct {
	root      string
	protector credentialbroker.Protector
}

func New(root string, protector credentialbroker.Protector) *Vault { return &Vault{root, protector} }
func (v *Vault) path(id string) (string, error) {
	if id == "" || strings.ContainsAny(id, `/\:<>"|?*`) || id == "." || id == ".." {
		return "", errors.New("invalid credential identifier")
	}
	return filepath.Join(v.root, strings.ToLower(id)+".sealed"), nil
}
func (v *Vault) Read(id string) (Record, error) {
	path, err := v.path(id)
	if err != nil {
		return Record{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Record{}, ErrMissing
	}
	if err != nil {
		return Record{}, err
	}
	plain, err := v.protector.Open(data)
	if err != nil {
		return Record{}, err
	}
	defer clear(plain)
	var r Record
	err = json.Unmarshal(plain, &r)
	return r, err
}
func (v *Vault) Write(id string, r Record) error {
	path, err := v.path(id)
	if err != nil {
		return err
	}
	plain, _ := json.Marshal(r)
	defer clear(plain)
	data, err := v.protector.Seal(plain)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(v.root, ".credential-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
func (v *Vault) Remove(id string) error {
	path, err := v.path(id)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
