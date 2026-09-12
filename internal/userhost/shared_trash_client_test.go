package userhost

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedFileRemoveUsesCentralRecycleAndPreservesFailedDeletion(t *testing.T) {
	ownerSID := "S-1-5-21-1000"
	base := t.TempDir()
	projectID := "project_1234567890"
	root := filepath.Join(base, "shared", ownerSID, projectID)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(file, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := newSharedFileManager(filepath.Join(base, ownerSID), ownerSID)
	if err != nil {
		t.Fatal(err)
	}
	input := sharedFileRequest{ProjectID: projectID, Operation: "remove", Path: "shared://" + projectID + "/notes.txt"}
	if _, err := manager.OperateFile(t.Context(), input); err == nil {
		t.Fatal("unconfigured recycle did not fail closed")
	}
	status := http.StatusForbidden
	var received map[string]string
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/runtime/shared-trash" || r.Header.Get("Authorization") != "Bearer registration-credential" {
			t.Errorf("invalid platform request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		if status == http.StatusOK {
			if err := os.Rename(file, filepath.Join(base, "recycled")); err != nil {
				t.Error(err)
			}
			w.Write([]byte(`{"id":"entry-1"}`))
		} else {
			w.WriteHeader(status)
			w.Write([]byte(`{"error":"forbidden"}`))
		}
	}))
	defer portal.Close()
	client, err := newAuditClient(portal.URL, "registration-credential", ownerSID)
	if err != nil {
		t.Fatal(err)
	}
	manager.recycle = client.recycleSharedFile
	if _, err := manager.OperateFile(t.Context(), input); err == nil || err.Error() != "forbidden" {
		t.Fatalf("expected rejection: %v", err)
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "keep" {
		t.Fatalf("failed recycle changed original: %q %v", data, err)
	}
	status = http.StatusOK
	result, err := manager.OperateFile(t.Context(), input)
	if err != nil || string(result) != "null" {
		t.Fatalf("remove = %s, %v", result, err)
	}
	if received["sid"] != ownerSID || received["projectId"] != projectID || received["operation"] != "recycle" || received["path"] != "notes.txt" {
		t.Fatalf("unexpected request fields: %v", received)
	}
	if data, err := os.ReadFile(filepath.Join(base, "recycled")); err != nil || string(data) != "keep" {
		t.Fatalf("recycled content = %q %v", data, err)
	}
}
