//go:build windows

package employee

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"workagent3/internal/credentialbroker"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

// Explicitly opt in on a disposable, already provisioned employee only. Never
// run this on an existing employee: it intentionally discards the managed secret
// and interrupts migration after Windows has changed the password.
func TestManagedCredentialsLiveRecovery(t *testing.T) {
	configPath := os.Getenv("WA3_CREDENTIAL_TEST_CONFIG")
	if configPath == "" {
		t.Skip("dedicated SYSTEM integration test")
	}
	username := os.Getenv("WA3_CREDENTIAL_TEST_USERNAME")
	if !strings.HasPrefix(username, "wa3cred-") {
		t.Fatal("disposable employee prefix required")
	}
	pid64, err := strconv.ParseUint(os.Getenv("WA3_CREDENTIAL_TEST_PID"), 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config WindowsPlatformConfig
	json.Unmarshal(data, &config)
	var paths struct{ DatabasePath string }
	json.Unmarshal(data, &paths)
	users, err := store.Open(paths.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	user, err := users.UserByUsername(t.Context(), username)
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
	original, err := vault.Read(user.SID)
	if err != nil {
		t.Fatal(err)
	}
	defer original.Clear()
	token, err := winutil.ProcessUserToken(uint32(pid64), user.SID)
	if err != nil {
		t.Fatal(err)
	}
	brokerPath := filepath.Join(config.DataRootBase, user.SID, "runtime", "credential-broker.db")
	db, err := sql.Open("sqlite", brokerPath)
	if err != nil {
		t.Fatal(err)
	}
	var sealed []byte
	err = winutil.WithUserToken(token, func() error {
		var err error
		sealed, err = credentialbroker.NewUserProtector().Seal([]byte("disposable-migration-secret"))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("INSERT OR REPLACE INTO credentials(id,kind,label,sealed_value,state,created_at,updated_at) VALUES('migration-fixture','provider','migration fixture',?,'ready',0,0)", sealed)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	before, err := readBrokerRecovery(t.Context(), brokerPath, token)
	token.Close()
	if err != nil {
		t.Fatal(err)
	}
	defer clear(before)
	if err := vault.Write(user.SID+"-fixture-original", original); err != nil {
		t.Fatal(err)
	}
	if err := vault.Remove(user.SID); err != nil {
		t.Fatal(err)
	}
	crash := errors.New("injected interruption after OS password change")
	err = p.maintainWindowsCredential(t.Context(), user, uint32(pid64), true, func() error { return crash })
	if !errors.Is(err, crash) {
		t.Fatalf("migration did not reach injected interruption: %v", err)
	}
	pending, err := vault.Read(user.SID)
	if err != nil {
		t.Fatal(err)
	}
	defer pending.Clear()
	if pending.Phase != "prepared" || len(pending.Pending) == 0 {
		t.Fatal("pending credential was not saved before Windows mutation")
	}
	restarted, err := NewWindowsPlatform(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.MaintainWindowsCredential(t.Context(), user, 0, true); err != nil {
		t.Fatal(err)
	}
	current, err := vault.Read(user.SID)
	if err != nil {
		t.Fatal(err)
	}
	defer current.Clear()
	if current.Phase != "" || bytes.Equal(current.Password, original.Password) {
		t.Fatal("adoption did not commit new credential")
	}
	checkBroker := func() {
		tok, err := winutil.LogonManagedUser(localWindowsUsername(user), current.Password)
		if err != nil {
			t.Fatal(err)
		}
		defer tok.Close()
		unload, err := loadMaintenanceProfile(tok, localWindowsUsername(user))
		if err != nil {
			t.Fatal(err)
		}
		defer unload()
		after, err := readBrokerRecovery(t.Context(), brokerPath, tok)
		defer clear(after)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("broker contents did not survive fresh logon: %v", err)
		}
	}
	checkBroker()
	if err := restarted.MaintainWindowsCredential(t.Context(), user, 0, false); err != nil {
		t.Fatal(err)
	}
	current.Clear()
	current, err = vault.Read(user.SID)
	if err != nil {
		t.Fatal(err)
	}
	checkBroker()
	if err := restarted.StartInstalledRuntime(t.Context(), user.SID); err != nil {
		t.Fatal(err)
	}
	t.Log("Adoption, interrupted password change, restart recovery, preserved DPAPI broker, normal rotation and fixed launcher startup passed")
}
