package portal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"workagent3/internal/runtimeapi"
)

type sharedACLStateStub struct {
	owner   string
	members []string
	root    []string
}

func (s sharedACLStateStub) ACLState(context.Context, string) (string, []string, error) {
	return s.owner, s.members, nil
}

func (s sharedACLStateStub) OwnerRootACLState(context.Context, string) ([]string, error) {
	if s.root != nil {
		return s.root, nil
	}
	return s.members, nil
}

func TestRuntimeSharedProjectPlatformRoutesDesiredStateToOwnerRuntime(t *testing.T) {
	requests := make(chan sharedRuntimeRequest, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/internal/shared-projects/project_1234567890" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer owner-runtime-token" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		var input sharedRuntimeRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		requests <- input
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	registry := runtimeapi.NewRegistry()
	if err := registry.Register(runtimeapi.Registration{SID: "S-1-5-21-1000", BaseURL: server.URL, Token: "owner-runtime-token", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	platform, err := NewRuntimeSharedProjectPlatform(registry, sharedACLStateStub{owner: "S-1-5-21-1000", members: []string{"S-1-5-21-2000"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := platform.ProvisionProject(t.Context(), "project_1234567890", "S-1-5-21-1000"); err != nil {
		t.Fatal(err)
	}
	if input := <-requests; input.Action != "provision" || input.OwnerSID != "S-1-5-21-1000" || len(input.MemberSIDs) != 0 || len(input.RootMemberSIDs) != 1 {
		t.Fatalf("provision input = %#v", input)
	}
	if err := platform.GrantProjectMember(t.Context(), "project_1234567890", "S-1-5-21-2000"); err != nil {
		t.Fatal(err)
	}
	if input := <-requests; input.Action != "reconcile" || len(input.MemberSIDs) != 1 || input.MemberSIDs[0] != "S-1-5-21-2000" || len(input.RootMemberSIDs) != 1 {
		t.Fatalf("reconcile input = %#v", input)
	}
}

func TestRuntimeSharedProjectPlatformFailsClosedWithoutOwnerRuntime(t *testing.T) {
	platform, err := NewRuntimeSharedProjectPlatform(runtimeapi.NewRegistry(), sharedACLStateStub{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := platform.ProvisionProject(t.Context(), "project_1234567890", "S-1-5-21-1000"); !errors.Is(err, runtimeapi.ErrRuntimeUnavailable) {
		t.Fatalf("missing runtime error = %v", err)
	}
}

// Cross-user transfers execute on the SYSTEM-side Employee Manager, not on an
// owner Runtime: a limited UserHost token cannot rewrite another account's
// owner or protected DACL.
func TestRuntimeSharedProjectPlatformTransfersThroughEmployeeManager(t *testing.T) {
	requests := make(chan sharedRuntimeRequest, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/v1/shared-projects/project_1234567890" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer manager-token" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		var input sharedRuntimeRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		requests <- input
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	manager, err := NewEmployeeManagerClient(server.URL, "manager-token")
	if err != nil {
		t.Fatal(err)
	}
	state := sharedACLStateStub{owner: "S-1-5-21-1000", members: []string{"S-1-5-21-2000", "S-1-5-21-3000"}, root: []string{"S-1-5-21-4000"}}
	platform, err := NewRuntimeSharedProjectPlatform(runtimeapi.NewRegistry(), state, manager)
	if err != nil {
		t.Fatal(err)
	}
	if err := platform.TransferProjectOwnership(t.Context(), "project_1234567890", "S-1-5-21-1000", "S-1-5-21-2000", []string{"S-1-5-21-1000", "S-1-5-21-2000", "S-1-5-21-3000"}); err != nil {
		t.Fatal(err)
	}
	prepared := <-requests
	if prepared.Action != "transfer" || prepared.OwnerSID != "S-1-5-21-2000" || prepared.OldOwnerSID != "S-1-5-21-1000" || len(prepared.MemberSIDs) != 2 || len(prepared.OldMemberSIDs) != 2 || len(prepared.PreviousRootMemberSIDs) != 1 || len(prepared.RootMemberSIDs) != 3 {
		t.Fatalf("transfer projection = %#v", prepared)
	}
	if err := platform.FinalizeProjectOwnership(t.Context(), "project_1234567890", "S-1-5-21-2000", true); err != nil {
		t.Fatal(err)
	}
	if finalized := <-requests; finalized.Action != "transfer_commit" || finalized.OwnerSID != "S-1-5-21-2000" {
		t.Fatalf("finalize projection = %#v", finalized)
	}
}

func TestRuntimeSharedProjectPlatformTransferFailsClosedWithoutEmployeeManager(t *testing.T) {
	platform, err := NewRuntimeSharedProjectPlatform(runtimeapi.NewRegistry(), sharedACLStateStub{owner: "S-1-5-21-1000"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := platform.TransferProjectOwnership(t.Context(), "project_1234567890", "S-1-5-21-1000", "S-1-5-21-2000", nil); err == nil {
		t.Fatal("transfer unexpectedly succeeded without the Employee Manager service")
	}
	if err := platform.FinalizeProjectOwnership(t.Context(), "project_1234567890", "S-1-5-21-2000", true); err == nil {
		t.Fatal("finalize unexpectedly succeeded without the Employee Manager service")
	}
}
