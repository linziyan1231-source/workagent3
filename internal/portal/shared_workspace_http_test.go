package portal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
)

type sharedStorageFixture struct{ available int64 }

func (s *sharedStorageFixture) StorageUsage(context.Context, string) (contracts.StorageUsage, error) {
	return contracts.StorageUsage{Shared: contracts.StorageQuota{Enabled: true, Hard: true, LimitBytes: s.available}}, nil
}
func (s *sharedStorageFixture) SetStorageLimits(context.Context, string, contracts.StorageLimits) (contracts.StorageUsage, error) {
	return s.StorageUsage(context.Background(), "")
}

func TestSharedUploadsAuthenticateEachRequestAndEnforceOwnerQuota(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer owner-runtime-token" || r.Header.Get("Cookie") != "" {
			t.Error("browser credentials forwarded to runtime")
		}
		if !strings.HasPrefix(r.URL.Path, "/v1/shared-workspaces/") {
			t.Error("wrong shared root")
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/uploads/upload-1234567890") {
			w.Write([]byte(`{"size":5}`))
			return
		}
		w.Write([]byte(`{"id":"upload-1234567890","path":"notes.txt","size":5}`))
	}))
	defer upstream.Close()
	endpoint, _ := url.Parse(upstream.URL)
	storage := &sharedStorageFixture{available: 10}
	handler, _, _, alice, bob := collaborationTestServer(t, func(s *Server) {
		s.runtimes = StaticRouter{"S-1-5-21-1000": runtimeapi.Endpoint{BaseURL: endpoint, Token: "owner-runtime-token"}}
		s.modules.Storage = storage
	})
	created := collaborationRequest(t, handler, alice.session, "POST", "/api/portal/shared-projects", `{"name":"Files"}`)
	var project struct {
		Project sharedProjectDTO `json:"project"`
	}
	if json.Unmarshal(created.Body.Bytes(), &project) != nil {
		t.Fatal(created.Body.String())
	}
	path := "/api/portal/shared-workspaces/" + project.Project.ID + "/uploads"
	forbidden := collaborationRequest(t, handler, bob.session, "POST", path, `{"size":5}`)
	if forbidden.Code != 403 && forbidden.Code != 404 {
		t.Fatalf("nonmember upload: %d", forbidden.Code)
	}
	oversized := collaborationRequest(t, handler, alice.session, "POST", path, `{"size":5368709121}`)
	if oversized.Code != 413 || calls != 0 {
		t.Fatalf("oversized upload reached runtime: %d", oversized.Code)
	}
	noSpace := collaborationRequest(t, handler, alice.session, "POST", path, `{"size":11}`)
	if noSpace.Code != 413 || !strings.Contains(noSpace.Body.String(), "shared_storage_exceeded") || calls != 0 {
		t.Fatal(noSpace.Body.String())
	}
	accepted := collaborationRequest(t, handler, alice.session, "POST", path, `{"size":5,"path":"notes.txt","name":"notes.txt","lastModified":0}`)
	if accepted.Code != 200 || calls != 1 {
		t.Fatal(accepted.Body.String())
	}
	storage.available = 4
	complete := collaborationRequest(t, handler, alice.session, "POST", path+"/upload-1234567890/complete", `{}`)
	if complete.Code != 413 || calls != 2 {
		t.Fatalf("completion did not recheck quota: %d, calls %d", complete.Code, calls)
	}
}
