//go:build windows

package employeemanager

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/winutil"
)

// The full cross-user transfer (move + owner/DACL rewrite + recovery journal)
// executes through the Employee Manager HTTP surface under its SYSTEM
// identity; this exercises the same journal location and manager the limited
// UserHost used before, so pre-fix journals stay readable.
func TestSharedTransferRouteExecutesFullTransfer(t *testing.T) {
	newOwnerSID, err := winutil.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	oldOwnerSID := "S-1-5-21-111111111-222222222-333333333-4444"
	base := t.TempDir()
	projectID := "project_1234567890"
	source := filepath.Join(base, "shared", oldOwnerSID, projectID)
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "brief.txt"), []byte("brief"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewSharedTransferManager(base)
	if err != nil {
		t.Fatal(err)
	}
	handler := Handler(&Service{SharedTransfers: manager}, "secret")

	call := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPut, "/v1/shared-projects/"+projectID, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer secret")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	transfer := call(`{"action":"transfer","ownerSid":"` + newOwnerSID + `","oldOwnerSid":"` + oldOwnerSID + `","memberSids":["` + oldOwnerSID + `"],"rootMemberSids":["` + oldOwnerSID + `"],"oldMemberSids":["` + newOwnerSID + `"]}`)
	if transfer.Code != http.StatusOK {
		t.Fatalf("transfer status %d: %s", transfer.Code, transfer.Body.String())
	}
	target := filepath.Join(base, "shared", newOwnerSID, projectID)
	if _, err := os.Stat(filepath.Join(target, "brief.txt")); err != nil {
		t.Fatalf("moved project missing: %v", err)
	}
	journal := filepath.Join(base, newOwnerSID, "runtime", "shared-project-transactions", projectID+".json")
	if _, err := os.Stat(journal); err != nil {
		t.Fatalf("recovery journal missing: %v", err)
	}
	commit := call(`{"action":"transfer_commit","ownerSid":"` + newOwnerSID + `","memberSids":[],"rootMemberSids":[]}`)
	if commit.Code != http.StatusOK {
		t.Fatalf("commit status %d: %s", commit.Code, commit.Body.String())
	}
	if _, err := os.Stat(journal); !os.IsNotExist(err) {
		t.Fatalf("committed recovery journal still exists: %v", err)
	}
}
