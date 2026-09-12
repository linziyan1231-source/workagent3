package portal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"workagent3/internal/collaboration"
	"workagent3/internal/runtimeapi"
)

type personalTaskRouter struct {
	endpoint runtimeapi.Endpoint
	sid      string
}

func (r *personalTaskRouter) Resolve(_ context.Context, sid string) (runtimeapi.Endpoint, error) {
	r.sid = sid
	return r.endpoint, nil
}

func TestPersonalTaskRuntimeRecoveryDoesNotNeedProjectDirectory(t *testing.T) {
	var posts, deletes int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Error("missing runtime authorization")
		}
		if r.URL.Path == "/v1/session-operations/ptask_operation_1234" && r.Method == http.MethodGet {
			writeJSON(w, 200, map[string]any{"operation": map[string]string{"state": "ready"}, "session": map[string]string{"id": "session-op-ptask_operation_1234", "workspaceId": "shared:gone-project"}})
			return
		}
		if r.Method == http.MethodPost {
			posts++
			writeError(w, 404, "shared_project_not_found")
			return
		}
		if r.URL.Path == "/v1/session-operations/ptask_operation_1234" && r.Method == http.MethodDelete {
			deletes++
			w.WriteHeader(204)
			return
		}
		t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		w.WriteHeader(500)
	}))
	defer server.Close()
	address, _ := url.Parse(server.URL)
	router := &personalTaskRouter{endpoint: runtimeapi.Endpoint{BaseURL: address, Token: "runtime-token"}}
	client := newRuntimePersonalTasks(router)
	op := collaboration.PersonalTaskOperation{ID: "ptask_operation_1234", CreatorSID: "S-1-5-21-2000", ProjectID: "gone-project", Configuration: json.RawMessage(`{"title":"Task","engine":"kimi"}`)}
	result, err := client.Create(t.Context(), op)
	if err != nil || len(result) == 0 || posts != 0 || router.sid != op.CreatorSID {
		t.Fatalf("lookup %s %v posts=%d", result, err, posts)
	}
	if err = client.Delete(t.Context(), op); err != nil || deletes != 1 {
		t.Fatalf("cancel %v deletes=%d", err, deletes)
	}
}

func TestPersonalTaskRuntimeSendsOnlyCreatorOperationAndChosenConfiguration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(404)
			return
		}
		var input map[string]any
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Fatal("body")
		}
		if input["operationId"] != "ptask_operation_1234" || input["sharedProjectId"] != "project-1" || input["modelId"] != "chosen" || input["permissionMode"] != "read_only" {
			t.Errorf("forwarded %#v", input)
		}
		if _, ok := input["payerSid"]; ok {
			t.Fatal("personal task has payer override")
		}
		writeJSON(w, 201, map[string]string{"id": "session-op-ptask_operation_1234"})
	}))
	defer server.Close()
	address, _ := url.Parse(server.URL)
	client := newRuntimePersonalTasks(&personalTaskRouter{endpoint: runtimeapi.Endpoint{BaseURL: address}})
	_, err := client.Create(t.Context(), collaboration.PersonalTaskOperation{ID: "ptask_operation_1234", CreatorSID: "S-1-5-21-2000", ProjectID: "project-1", Configuration: json.RawMessage(`{"title":"Task","engine":"kimi","modelId":"chosen","permissionMode":"read_only"}`)})
	if err != nil {
		t.Fatal(err)
	}
}
