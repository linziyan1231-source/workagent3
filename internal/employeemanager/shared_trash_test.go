package employeemanager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/sharedtrash"
)

func TestSharedTrashHTTPRequiresManagerTokenAndPreservesDTOAndErrors(t *testing.T) {
	base := t.TempDir()
	project, sid := "project_1234567890", "S-1-5-21-1000"
	root := filepath.Join(base, "shared", sid, project)
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	trash, err := sharedtrash.New(base)
	if err != nil {
		t.Fatal(err)
	}
	handler := Handler(&Service{SharedTrash: trash}, "manager-token")
	call := func(token, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/v1/shared-trash/"+project, strings.NewReader(body))
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	input := `{"ownerSID":"` + sid + `","operation":"recycle","path":"notes.txt"}`
	if got := call("", input); got.Code != 401 {
		t.Fatalf("unauthenticated = %d", got.Code)
	}
	if _, err := os.Stat(name); err != nil {
		t.Fatal("unauthorized request deleted file")
	}
	got := call("manager-token", input)
	var entry contracts.SharedTrashEntry
	if got.Code != 200 || json.Unmarshal(got.Body.Bytes(), &entry) != nil || entry.Name != "notes.txt" || entry.ID == "" {
		t.Fatalf("recycle = %d %s", got.Code, got.Body.String())
	}
	if err := os.WriteFile(name, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	got = call("manager-token", `{"ownerSID":"`+sid+`","operation":"restore","entryId":"`+entry.ID+`"}`)
	if got.Code != 409 || !strings.Contains(got.Body.String(), `"error":"file_exists"`) {
		t.Fatalf("conflict = %d %s", got.Code, got.Body.String())
	}
	got = call("manager-token", `{"ownerSID":"`+sid+`","operation":"list"}`)
	var listing contracts.SharedTrashList
	if got.Code != 200 || json.Unmarshal(got.Body.Bytes(), &listing) != nil || len(listing.Entries) != 1 || listing.LimitBytes != sharedtrash.LimitBytes {
		t.Fatalf("list = %d %s", got.Code, got.Body.String())
	}
	got = call("manager-token", `{"ownerSID":"`+sid+`","operation":"purge","entryId":"`+entry.ID+`"}`)
	if got.Code != 200 || strings.TrimSpace(got.Body.String()) != "{}" {
		t.Fatalf("purge = %d %s", got.Code, got.Body.String())
	}
	got = call("manager-token", `{"ownerSID":"`+sid+`","operation":"restore","entryId":"`+entry.ID+`"}`)
	if got.Code != 404 || !strings.Contains(got.Body.String(), "trash_entry_not_found") {
		t.Fatalf("missing = %d %s", got.Code, got.Body.String())
	}
}

func TestRetentionWorkerImportsWithoutRuntimeOrBrowser(t *testing.T) {
	base := t.TempDir()
	project, sid := "project_1234567890", "S-1-5-21-1000"
	legacy := filepath.Join(base, "shared", sid, project, ".workagent-trash")
	if err := os.MkdirAll(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "retained.txt"), []byte("legacy"), 0600); err != nil {
		t.Fatal(err)
	}
	trash, err := sharedtrash.New(base)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() { (&Service{SharedTrash: trash}).RunSharedTrashRetention(ctx); close(done) }()
	deadline := time.After(3 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			t.Fatal("startup retention did not import legacy trash")
		case <-tick.C:
			items, err := os.ReadDir(legacy)
			if err != nil {
				t.Fatal(err)
			}
			if len(items) == 0 {
				cancel()
				<-done
				return
			}
		}
	}
}
