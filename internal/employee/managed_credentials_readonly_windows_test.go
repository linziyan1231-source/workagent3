//go:build windows

package employee

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

// Read-only acceptance under a fresh employee logon, run by SYSTEM on the test host.
func TestManagedCredentialLiveReadOnly(t *testing.T) {
	configPath := os.Getenv("WA3_CREDENTIAL_TEST_CONFIG")
	if configPath == "" {
		t.Skip("dedicated SYSTEM integration test")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config WindowsPlatformConfig
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	var paths struct{ DatabasePath string }
	json.Unmarshal(data, &paths)
	users, err := store.Open(paths.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	user, err := users.UserByUsername(t.Context(), os.Getenv("WA3_CREDENTIAL_TEST_USERNAME"))
	if err != nil {
		t.Fatal(err)
	}
	p, err := NewWindowsPlatform(config)
	if err != nil {
		t.Fatal(err)
	}
	vault, err := p.vault()
	if err != nil {
		t.Fatal(err)
	}
	record, err := vault.Read(user.SID)
	if err != nil {
		t.Fatal(err)
	}
	defer record.Clear()
	if record.Phase != "" || len(record.Password) == 0 {
		t.Fatal("credential maintenance not complete")
	}
	token, err := winutil.LogonManagedUser(localWindowsUsername(user), record.Password)
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	unload, err := loadMaintenanceProfile(token, localWindowsUsername(user))
	if err != nil {
		t.Fatal(err)
	}
	defer unload()
	broker, err := readBrokerRecovery(t.Context(), filepath.Join(config.DataRootBase, user.SID, "runtime", "credential-broker.db"), token)
	clear(broker)
	if err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		path  string
		flags int
	}{
		{filepath.Join(config.CredentialRoot, user.SID+".sealed"), os.O_RDONLY},
		{filepath.Join(config.LaunchManifestRoot, user.SID+".json"), os.O_WRONLY},
		{config.LauncherExecutable, os.O_WRONLY},
	}
	for _, check := range checks {
		err := winutil.WithUserToken(token, func() error {
			f, err := os.OpenFile(check.path, check.flags, 0)
			if err == nil {
				f.Close()
			}
			return err
		})
		if !os.IsPermission(err) {
			t.Fatalf("employee access was not denied for %s: %v", check.path, err)
		}
	}
	t.Log("Retained password login, fresh-profile broker decryption and employee ACL isolation passed")
}
