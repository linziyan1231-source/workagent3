package portal

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

func setupAdminAuditServer(t *testing.T) (*Server, *audit.Store) {
	t.Helper()
	users, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { users.Close() })
	auditStore, err := audit.Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { auditStore.Close() })
	admin, err := users.CreateUser(t.Context(), "manager", "S-1-5-21-9000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.SetUserAdmin(t.Context(), admin.Username, true); err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(t.Context(), "admin-session", admin.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	member, err := users.CreateUser(t.Context(), "alice", "S-1-5-21-9001", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(t.Context(), "user-session", member.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(users, StaticRouter{}, false, Modules{Audit: auditStore})
	if err != nil {
		t.Fatal(err)
	}
	return server, auditStore
}

func seedAdminAuditEvents(t *testing.T, auditStore *audit.Store) {
	t.Helper()
	ctx := t.Context()
	events := []contracts.AuditInput{
		{Actor: "manager", Target: "alice", Action: audit.ActionEmployeeDisable, Result: "success", CorrelationID: "corr-1"},
		{Actor: "S-1-5-21-100", Target: "run-9", Action: audit.ActionQuotaReserve, Result: "denied", CorrelationID: "run-9", Metadata: map[string]string{"model_id": "codex-native", "access_token": "should-never-appear"}},
		{Actor: "manager", Target: "proj-1", Action: audit.ActionCollaborationACLGrant, Result: "success", CorrelationID: "corr-3"},
	}
	for _, input := range events {
		if _, err := auditStore.Record(ctx, input); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAdminAuditQueryRequiresAdmin(t *testing.T) {
	server, _ := setupAdminAuditServer(t)
	unauthenticated := auditRequest(server.Handler(), http.MethodGet, "/api/portal/admin/audit", "", "")
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d", unauthenticated.Code)
	}
	member := auditRequest(server.Handler(), http.MethodGet, "/api/portal/admin/audit", "", "user-session")
	if member.Code != http.StatusForbidden {
		t.Fatalf("non-admin status=%d", member.Code)
	}
	export := auditRequest(server.Handler(), http.MethodGet, "/api/portal/admin/audit/export", "", "user-session")
	if export.Code != http.StatusForbidden {
		t.Fatalf("non-admin export status=%d", export.Code)
	}
}

func TestAdminAuditQueryFiltersAndRedacts(t *testing.T) {
	server, auditStore := setupAdminAuditServer(t)
	seedAdminAuditEvents(t, auditStore)

	response := auditRequest(server.Handler(), http.MethodGet, "/api/portal/admin/audit?action=quota.reserve&actor=S-1-5-21-100", "", "admin-session")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Events []contracts.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || len(payload.Events) != 1 {
		t.Fatalf("payload=%s err=%v", response.Body.String(), err)
	}
	event := payload.Events[0]
	if event.Action != audit.ActionQuotaReserve || event.Result != "denied" || event.Target != "run-9" {
		t.Fatalf("unexpected event: %#v", event)
	}
	if event.Metadata["access_token"] != "[redacted]" || event.Metadata["model_id"] != "codex-native" {
		t.Fatalf("redaction missing: %#v", event.Metadata)
	}
	if strings.Contains(response.Body.String(), "should-never-appear") {
		t.Fatal("sensitive metadata leaked into the query response")
	}

	byTarget := auditRequest(server.Handler(), http.MethodGet, "/api/portal/admin/audit?target=proj-1", "", "admin-session")
	var filtered struct {
		Events []contracts.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(byTarget.Body.Bytes(), &filtered); err != nil || len(filtered.Events) != 1 || filtered.Events[0].Action != audit.ActionCollaborationACLGrant {
		t.Fatalf("target filter payload=%s err=%v", byTarget.Body.String(), err)
	}

	badWindow := auditRequest(server.Handler(), http.MethodGet, "/api/portal/admin/audit?from=not-a-time", "", "admin-session")
	if badWindow.Code != http.StatusBadRequest {
		t.Fatalf("invalid from status=%d", badWindow.Code)
	}
}

func TestAdminAuditExportMatchesCLIFormatAndRedacts(t *testing.T) {
	server, auditStore := setupAdminAuditServer(t)
	seedAdminAuditEvents(t, auditStore)

	response := auditRequest(server.Handler(), http.MethodGet, "/api/portal/admin/audit/export", "", "admin-session")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if disposition := response.Header().Get("Content-Disposition"); !strings.Contains(disposition, "attachment") || !strings.Contains(disposition, "audit-export-") {
		t.Fatalf("disposition=%q", disposition)
	}
	// Same shape as cmd/audit-export: a bare indented JSON array.
	var events []contracts.AuditEvent
	if err := json.Unmarshal(response.Body.Bytes(), &events); err != nil || len(events) != 3 {
		t.Fatalf("export payload err=%v body=%s", err, response.Body.String())
	}
	if !strings.HasPrefix(response.Body.String(), "[\n  {") {
		t.Fatalf("export is not the indented array format: %.40s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "should-never-appear") {
		t.Fatal("sensitive metadata leaked into the export")
	}
}
