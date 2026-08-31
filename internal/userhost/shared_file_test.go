package userhost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSharedFileManagerRoutesOnlyInsideOwnedProject(t *testing.T) {
	ownerSID := "S-1-5-21-1000"
	base := t.TempDir()
	dataRoot := filepath.Join(base, ownerSID)
	projectID := "project_1234567890"
	projectRoot := filepath.Join(base, "shared", ownerSID, projectID)
	if err := os.MkdirAll(projectRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(projectRoot, "notes.md")
	if err := os.WriteFile(filePath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := newSharedFileManager(dataRoot, ownerSID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "metadata", Path: "shared://" + projectID + "/notes.md"})
	if err != nil || !strings.Contains(string(result), `"path":"shared://`+projectID+`/notes.md"`) {
		t.Fatalf("result = %s, %v", result, err)
	}
	read, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "read", Path: "notes.md"})
	if err != nil || string(read) != `"hello"` {
		t.Fatalf("read = %s, %v", read, err)
	}
	written, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "write", Path: "draft.md", Data: "draft"})
	if err != nil || string(written) != "true" {
		t.Fatalf("write = %s, %v", written, err)
	}
	renamed, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "rename", Path: "draft.md", NewName: "final.md"})
	if err != nil || !strings.Contains(string(renamed), "shared://"+projectID+"/final.md") {
		t.Fatalf("rename = %s, %v", renamed, err)
	}
	listed, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "list"})
	var files []map[string]string
	if err != nil || json.Unmarshal(listed, &files) != nil || len(files) != 2 {
		t.Fatalf("list = %s, %v", listed, err)
	}
	if _, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "read", Path: "../secret.txt"}); err == nil {
		t.Fatal("path traversal was accepted")
	}
	if _, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "remove"}); err == nil {
		t.Fatal("project root removal was accepted")
	}
}

func TestSharedFileManagerRejectsSymlinkTraversal(t *testing.T) {
	ownerSID := "S-1-5-21-1000"
	base := t.TempDir()
	dataRoot := filepath.Join(base, ownerSID)
	projectID := "project_1234567890"
	projectRoot := filepath.Join(base, "shared", ownerSID, projectID)
	if err := os.MkdirAll(projectRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(projectRoot, "outside")
	if err := os.Symlink(t.TempDir(), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	manager, err := newSharedFileManager(dataRoot, ownerSID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "read", Path: "outside/secret.txt"}); err == nil {
		t.Fatal("symlink traversal was accepted")
	}
	if _, err := manager.OperateFile(t.Context(), sharedFileRequest{ProjectID: projectID, Operation: "list"}); err == nil {
		t.Fatal("workspace list accepted a symlink")
	}
}
