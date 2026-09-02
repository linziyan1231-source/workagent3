//go:build windows

package userhost

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"workagent3/internal/winutil"
)

func TestSharedProjectTransferJournalCommitsMovedProject(t *testing.T) {
	newOwnerSID, err := winutil.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	oldOwnerSID := "S-1-5-21-111111111-222222222-333333333-4444"
	base := t.TempDir()
	dataRoot := filepath.Join(base, newOwnerSID)
	projectID := "project_1234567890"
	source := filepath.Join(base, "shared", oldOwnerSID, projectID)
	targetOwnerRoot := filepath.Join(base, "shared", newOwnerSID)
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(targetOwnerRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataRoot, "runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "brief.txt"), []byte("brief"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := newSharedProjectManager(dataRoot, newOwnerSID)
	if err != nil {
		t.Fatal(err)
	}
	request := sharedProjectRequest{Action: "transfer", OwnerSID: newOwnerSID, OldOwnerSID: oldOwnerSID, MemberSIDs: []string{oldOwnerSID}, RootMemberSIDs: []string{oldOwnerSID}, OldMemberSIDs: []string{newOwnerSID}}
	if err := manager.Apply(context.Background(), projectID, request); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(targetOwnerRoot, projectID)
	if _, err := os.Stat(filepath.Join(target, "brief.txt")); err != nil {
		t.Fatalf("moved project missing: %v", err)
	}
	if _, err := os.Stat(manager.transferJournalPath(projectID)); err != nil {
		t.Fatalf("recovery journal missing: %v", err)
	}
	if err := manager.Apply(context.Background(), projectID, sharedProjectRequest{Action: "transfer_commit", OwnerSID: newOwnerSID}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(manager.transferJournalPath(projectID)); !os.IsNotExist(err) {
		t.Fatalf("committed recovery journal still exists: %v", err)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("old project path still exists: %v", err)
	}
	if err := manager.Apply(context.Background(), projectID, sharedProjectRequest{Action: "transfer_commit", OwnerSID: newOwnerSID}); err != nil {
		t.Fatalf("replayed transfer commit was not idempotent: %v", err)
	}
}

// A member who never owned a shared project has no per-owner root yet; the
// transfer must create it (with ACLs applied by ApplySharedOwnerRoot) instead
// of failing, or the Portal reports shared_project_acl_failed for every
// first-time target owner.
func TestSharedProjectTransferCreatesMissingTargetOwnerRoot(t *testing.T) {
	newOwnerSID, err := winutil.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	oldOwnerSID := "S-1-5-21-111111111-222222222-333333333-4444"
	base := t.TempDir()
	dataRoot := filepath.Join(base, newOwnerSID)
	projectID := "project_0987654321"
	source := filepath.Join(base, "shared", oldOwnerSID, projectID)
	targetOwnerRoot := filepath.Join(base, "shared", newOwnerSID)
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataRoot, "runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "brief.txt"), []byte("brief"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := newSharedProjectManager(dataRoot, newOwnerSID)
	if err != nil {
		t.Fatal(err)
	}
	request := sharedProjectRequest{Action: "transfer", OwnerSID: newOwnerSID, OldOwnerSID: oldOwnerSID, MemberSIDs: []string{oldOwnerSID}, RootMemberSIDs: []string{oldOwnerSID}, OldMemberSIDs: []string{newOwnerSID}}
	if err := manager.Apply(context.Background(), projectID, request); err != nil {
		t.Fatalf("transfer with a missing target owner root failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(targetOwnerRoot, projectID, "brief.txt")); err != nil {
		t.Fatalf("moved project missing: %v", err)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("old project path still exists: %v", err)
	}
	if err := manager.Apply(context.Background(), projectID, sharedProjectRequest{Action: "transfer_commit", OwnerSID: newOwnerSID}); err != nil {
		t.Fatal(err)
	}
}
