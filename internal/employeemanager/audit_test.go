package employeemanager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
	"workagent3/internal/employee"
	"workagent3/internal/store"
)

func openAuditFixtures(t *testing.T) (*store.Store, *audit.Store) {
	t.Helper()
	data, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	auditStore, err := audit.Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { auditStore.Close() })
	return data, auditStore
}

func TestLifecycleActionsRecordActorFromPortalHeaders(t *testing.T) {
	data, auditStore := openAuditFixtures(t)
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	service := &Service{Lifecycle: employee.Lifecycle{Users: data}, Audit: auditStore}
	handler := Handler(service, "secret")

	request := httptest.NewRequest(http.MethodPost, "/v1/users/reset-password", strings.NewReader(`{"username":"alice","portal_password":"correct horse battery staple"}`))
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set(actorHeader, "manager")
	request.Header.Set(correlationHeader, "corr-request-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("reset-password status=%d body=%s", response.Code, response.Body.String())
	}
	events, err := auditStore.List(t.Context(), contracts.AuditQuery{Action: audit.ActionEmployeePasswordReset})
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	event := events[0]
	if event.Actor != "manager" || event.Target != "alice" || event.Result != "success" || event.CorrelationID != "corr-request-1" {
		t.Fatalf("unexpected event: %#v", event)
	}
	if encoded, _ := json.Marshal(event); strings.Contains(string(encoded), "correct horse") {
		t.Fatalf("password leaked into audit event: %s", encoded)
	}
}

func TestProvisionJobTerminalFailureIsAudited(t *testing.T) {
	_, auditStore := openAuditFixtures(t)
	// A Provisioner without dependencies fails fast, exercising the
	// asynchronous job terminal failure path.
	service := &Service{Provisioner: &employee.Provisioner{}, Audit: auditStore}
	ctx := withAuditScope(context.Background(), "manager", "corr-provision-1")
	job, err := service.StartProvision(ctx, "alice", []byte("correct horse battery staple"))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		current, err := service.ProvisionJob(context.Background(), job.ID)
		if err != nil {
			t.Fatal(err)
		}
		if current.Status == "failed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job did not reach a terminal state: %#v", current)
		}
		time.Sleep(10 * time.Millisecond)
	}
	events, err := auditStore.List(t.Context(), contracts.AuditQuery{Action: audit.ActionEmployeeProvision})
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	event := events[0]
	if event.Actor != "manager" || event.Target != "alice" || event.Result != "failure" || event.CorrelationID != "corr-provision-1" || event.Metadata["error_code"] != "PROVISION_FAILED" {
		t.Fatalf("unexpected terminal event: %#v", event)
	}
}
