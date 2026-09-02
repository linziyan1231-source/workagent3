//go:build windows

package modelgateway

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/winutil"
)

// restrictTestKeyFileACL applies the production management key ACL policy to a
// temporary test key file: inheritance is removed and only Administrators,
// SYSTEM, and the current account retain access. Test temp directories inherit
// broader ACEs on developer machines, which the startup gate rightly rejects.
func restrictTestKeyFileACL(t *testing.T, path string) {
	t.Helper()
	current, err := winutil.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("icacls", path, "/inheritance:r", "/grant:r",
		"*"+administratorsSID+":F", "*"+localSystemSID+":F", "*"+current+":R").CombinedOutput()
	if err != nil {
		t.Fatalf("restrict test key file ACL: %v: %s", err, output)
	}
}

func TestVerifyManagementKeyFileACLRejectsExtraPrincipal(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "management.key")
	if err := os.WriteFile(keyFile, []byte("0123456789abcdef0123456789abcdef01234567\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	restrictTestKeyFileACL(t, keyFile)
	if err := verifyManagementKeyFileACL(keyFile); err != nil {
		t.Fatalf("restricted key file was rejected: %v", err)
	}
	if output, err := exec.Command("icacls", keyFile, "/grant", "*S-1-5-32-545:R").CombinedOutput(); err != nil {
		t.Fatalf("grant Users read: %v: %s", err, output)
	}
	err := verifyManagementKeyFileACL(keyFile)
	if err == nil || !strings.Contains(err.Error(), "S-1-5-32-545") {
		t.Fatalf("key file readable by Users was not rejected: %v", err)
	}
}
