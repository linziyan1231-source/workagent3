package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
	"workagent3/internal/notifications"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

const (
	adminMigrationsSIDAlice = "S-1-5-21-9101"
	adminMigrationsSIDBob   = "S-1-5-21-9102"
)

// fakeMigrationRuntime serves the per-SID runtime gateway migration endpoints.
type fakeMigrationRuntime struct {
	server        *httptest.Server
	resolveBodies []string
	retryBodies   []string
}

func newFakeMigrationRuntime(t *testing.T, token string) *fakeMigrationRuntime {
	t.Helper()
	fake := &fakeMigrationRuntime{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/migrations/skills-mcp", func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+token {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"results":[
			{"sourceId":"legacy-mcp","targetId":"mcp-1","kind":"mcp_server","status":"needs_auth","reason":"oauth_reauthorization_required"},
			{"sourceId":"legacy-skill","targetId":"skill-1","kind":"skill","status":"needs_review","reason":"migration_interrupted_retry_required"},
			{"sourceId":"fine-skill","targetId":"skill-2","kind":"skill","status":"ready"}]}`))
	})
	mux.HandleFunc("POST /v1/migrations/resolve", func(writer http.ResponseWriter, request *http.Request) {
		var input map[string]string
		_ = json.NewDecoder(request.Body).Decode(&input)
		fake.resolveBodies = append(fake.resolveBodies, input["kind"]+":"+input["sourceId"])
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"result": map[string]string{
			"sourceId": input["sourceId"], "targetId": "skill-1", "kind": input["kind"], "status": "ready", "reason": "manually_resolved"}})
	})
	mux.HandleFunc("POST /v1/migrations/retry", func(writer http.ResponseWriter, request *http.Request) {
		var input map[string]string
		_ = json.NewDecoder(request.Body).Decode(&input)
		fake.retryBodies = append(fake.retryBodies, input["kind"]+":"+input["sourceId"])
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"result": map[string]string{
			"sourceId": input["sourceId"], "targetId": "mcp-1", "kind": input["kind"], "status": "ready"}})
	})
	fake.server = httptest.NewServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

func setupAdminMigrationsServer(t *testing.T) (*Server, *audit.Store, *notifications.Store, *fakeMigrationRuntime) {
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
	notices, err := notifications.Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { notices.Close() })
	admin, err := users.CreateUser(t.Context(), "manager", "S-1-5-21-9100", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.SetUserAdmin(t.Context(), admin.Username, true); err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(t.Context(), "admin-session", admin.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	member, err := users.CreateUser(t.Context(), "alice", adminMigrationsSIDAlice, "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(t.Context(), "user-session", member.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	// Bob's runtime is down, so his SID shows up as unreachable.
	if _, err := users.CreateUser(t.Context(), "bob", adminMigrationsSIDBob, "hash"); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeMigrationRuntime(t, "runtime-token")
	runtimeURL, _ := url.Parse(runtime.server.URL)
	server, err := NewWithModules(users, StaticRouter{adminMigrationsSIDAlice: runtimeapi.Endpoint{BaseURL: runtimeURL, Token: "runtime-token"}}, false, Modules{Audit: auditStore, Notifications: notices})
	if err != nil {
		t.Fatal(err)
	}
	return server, auditStore, notices, runtime
}

func listAdminMigrations(t *testing.T, handler http.Handler, query string) ([]contracts.AdminMigrationItem, []string) {
	t.Helper()
	response := auditRequest(handler, http.MethodGet, "/api/portal/admin/migrations"+query, "", "admin-session")
	if response.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Items           []contracts.AdminMigrationItem `json:"items"`
		UnreachableSIDs []string                       `json:"unreachable_sids"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("list payload err=%v body=%s", err, response.Body.String())
	}
	return payload.Items, payload.UnreachableSIDs
}

func TestAdminMigrationsRequireAdmin(t *testing.T) {
	server, _, _, _ := setupAdminMigrationsServer(t)
	handler := server.Handler()
	for _, path := range []string{"/api/portal/admin/migrations", "/api/portal/admin/migration-jobs?id=x"} {
		if response := auditRequest(handler, http.MethodGet, path, "", "user-session"); response.Code != http.StatusForbidden {
			t.Fatalf("non-admin GET %s status=%d", path, response.Code)
		}
	}
	itemID := encodeMigrationItemID(migrationItemRef{sid: adminMigrationsSIDAlice, kind: "skill", sourceID: "legacy-skill"})
	for _, action := range []string{"retry", "resolve", "reauthorize"} {
		if response := auditRequest(handler, http.MethodPost, "/api/portal/admin/migrations/"+itemID+"/"+action, "", "user-session"); response.Code != http.StatusForbidden {
			t.Fatalf("non-admin %s status=%d", action, response.Code)
		}
		if response := auditRequest(handler, http.MethodPost, "/api/portal/admin/migrations/"+itemID+"/"+action, "", ""); response.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s status=%d", action, response.Code)
		}
	}
}

func TestAdminMigrationsListFiltersAcrossSIDs(t *testing.T) {
	server, _, _, _ := setupAdminMigrationsServer(t)
	handler := server.Handler()

	items, unreachable := listAdminMigrations(t, handler, "")
	if len(unreachable) != 1 || unreachable[0] != adminMigrationsSIDBob {
		t.Fatalf("unreachable SIDs=%v", unreachable)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 actionable items, got %#v", items)
	}
	for _, item := range items {
		if item.SID != adminMigrationsSIDAlice || item.Username != "alice" || item.ID == "" {
			t.Fatalf("unexpected item: %#v", item)
		}
	}
	needsAuth, _ := listAdminMigrations(t, handler, "?status=needs_auth")
	if len(needsAuth) != 1 || needsAuth[0].SourceID != "legacy-mcp" || needsAuth[0].Kind != "mcp_server" || needsAuth[0].Reason != "oauth_reauthorization_required" {
		t.Fatalf("status filter payload=%#v", needsAuth)
	}
	bySID, _ := listAdminMigrations(t, handler, "?sid="+adminMigrationsSIDAlice)
	if len(bySID) != 2 {
		t.Fatalf("sid filter payload=%#v", bySID)
	}
	unknownSID, _ := listAdminMigrations(t, handler, "?sid=S-1-5-21-9999")
	if len(unknownSID) != 0 {
		t.Fatalf("unknown sid should be empty: %#v", unknownSID)
	}
	if response := auditRequest(handler, http.MethodGet, "/api/portal/admin/migrations?status=bogus", "", "admin-session"); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid status filter=%d", response.Code)
	}
}

func adminMigrationItemID(t *testing.T, handler http.Handler, sourceID string) string {
	t.Helper()
	items, _ := listAdminMigrations(t, handler, "")
	for _, item := range items {
		if item.SourceID == sourceID {
			return item.ID
		}
	}
	t.Fatalf("item %s not listed", sourceID)
	return ""
}

func auditEventsFor(t *testing.T, auditStore *audit.Store, action string) []contracts.AuditEvent {
	t.Helper()
	events, err := auditStore.List(t.Context(), contracts.AuditQuery{Action: action})
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func TestAdminMigrationResolveRecordsAudit(t *testing.T) {
	server, auditStore, _, runtime := setupAdminMigrationsServer(t)
	handler := server.Handler()
	itemID := adminMigrationItemID(t, handler, "legacy-skill")

	response := auditRequest(handler, http.MethodPost, "/api/portal/admin/migrations/"+itemID+"/resolve", "", "admin-session")
	if response.Code != http.StatusOK {
		t.Fatalf("resolve status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Item contracts.AdminMigrationItem `json:"item"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || payload.Item.Status != "ready" || payload.Item.Reason != "manually_resolved" || payload.Item.Username != "alice" {
		t.Fatalf("resolve payload err=%v body=%s", err, response.Body.String())
	}
	if len(runtime.resolveBodies) != 1 || runtime.resolveBodies[0] != "skill:legacy-skill" {
		t.Fatalf("runtime resolve calls=%v", runtime.resolveBodies)
	}
	events := auditEventsFor(t, auditStore, audit.ActionMigrationDispositionResolve)
	if len(events) != 1 || events[0].Actor != "manager" || events[0].Result != "success" || events[0].Target != adminMigrationsSIDAlice+":legacy-skill" || events[0].Metadata["kind"] != "skill" {
		t.Fatalf("resolve audit events=%#v", events)
	}

	bogus := auditRequest(handler, http.MethodPost, "/api/portal/admin/migrations/not-an-id/resolve", "", "admin-session")
	if bogus.Code != http.StatusBadRequest {
		t.Fatalf("invalid item id status=%d", bogus.Code)
	}
}

func TestAdminMigrationRetryRunsAsPolledJob(t *testing.T) {
	server, auditStore, _, runtime := setupAdminMigrationsServer(t)
	handler := server.Handler()
	itemID := adminMigrationItemID(t, handler, "legacy-mcp")

	response := auditRequest(handler, http.MethodPost, "/api/portal/admin/migrations/"+itemID+"/retry", "", "admin-session")
	if response.Code != http.StatusAccepted {
		t.Fatalf("retry status=%d body=%s", response.Code, response.Body.String())
	}
	var accepted struct {
		Job contracts.MigrationDispositionJob `json:"job"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &accepted); err != nil || accepted.Job.ID == "" || accepted.Job.Status != "running" {
		t.Fatalf("retry payload err=%v body=%s", err, response.Body.String())
	}

	var job contracts.MigrationDispositionJob
	deadline := time.Now().Add(5 * time.Second)
	for {
		poll := auditRequest(handler, http.MethodGet, "/api/portal/admin/migration-jobs?id="+accepted.Job.ID, "", "admin-session")
		if poll.Code != http.StatusOK {
			t.Fatalf("poll status=%d body=%s", poll.Code, poll.Body.String())
		}
		var polled struct {
			Job contracts.MigrationDispositionJob `json:"job"`
		}
		if err := json.Unmarshal(poll.Body.Bytes(), &polled); err != nil {
			t.Fatalf("poll payload err=%v", err)
		}
		job = polled.Job
		if job.Status != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("migration job never finished")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if job.Status != "succeeded" || job.Percent != 100 || job.Item == nil || job.Item.Status != "ready" || job.Item.SourceID != "legacy-mcp" {
		t.Fatalf("job=%#v", job)
	}
	if len(runtime.retryBodies) != 1 || runtime.retryBodies[0] != "mcp_server:legacy-mcp" {
		t.Fatalf("runtime retry calls=%v", runtime.retryBodies)
	}
	events := auditEventsFor(t, auditStore, audit.ActionMigrationDispositionRetry)
	if len(events) != 1 || events[0].Actor != "manager" || events[0].Result != "success" {
		t.Fatalf("retry audit events=%#v", events)
	}

	missing := auditRequest(handler, http.MethodGet, "/api/portal/admin/migration-jobs?id=nope", "", "admin-session")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("unknown job status=%d", missing.Code)
	}
}

func TestAdminMigrationReauthorizeNotifiesEmployee(t *testing.T) {
	server, auditStore, notices, _ := setupAdminMigrationsServer(t)
	handler := server.Handler()
	itemID := adminMigrationItemID(t, handler, "legacy-mcp")

	response := auditRequest(handler, http.MethodPost, "/api/portal/admin/migrations/"+itemID+"/reauthorize", "", "admin-session")
	if response.Code != http.StatusOK {
		t.Fatalf("reauthorize status=%d body=%s", response.Code, response.Body.String())
	}
	published, err := notices.List(t.Context(), adminMigrationsSIDAlice, 10)
	if err != nil || len(published) != 1 {
		t.Fatalf("notifications=%#v err=%v", published, err)
	}
	if published[0].Kind != "migration_reauth" || published[0].DeepLink != "/settings/ext/workagent-migration" || !strings.Contains(published[0].Message, "legacy-mcp") {
		t.Fatalf("notification=%#v", published[0])
	}
	events := auditEventsFor(t, auditStore, audit.ActionMigrationDispositionReauthorize)
	if len(events) != 1 || events[0].Actor != "manager" || events[0].Result != "success" {
		t.Fatalf("reauthorize audit events=%#v", events)
	}

	// A needs_review item is not waiting for re-authorization.
	reviewID := adminMigrationItemID(t, handler, "legacy-skill")
	conflict := auditRequest(handler, http.MethodPost, "/api/portal/admin/migrations/"+reviewID+"/reauthorize", "", "admin-session")
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "migration_item_not_needs_auth") {
		t.Fatalf("needs_review reauthorize status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	// An item the runtime no longer journals is gone.
	ghost := auditRequest(handler, http.MethodPost, "/api/portal/admin/migrations/"+encodeMigrationItemID(migrationItemRef{sid: adminMigrationsSIDAlice, kind: "skill", sourceID: "ghost"})+"/reauthorize", "", "admin-session")
	if ghost.Code != http.StatusNotFound {
		t.Fatalf("ghost reauthorize status=%d", ghost.Code)
	}
}
