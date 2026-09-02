package portal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

// Migration recovery console (W14). The journaled migration results live in
// each employee UserHost (skill-migration.db), so the Portal fans out to the
// registered runtimes and merges the needs_auth/needs_review items across
// SIDs. Dispositions reuse the runtime gateway endpoints: retry re-evaluates
// and re-projects (slow, so it runs as a 202 + polled job like employee
// provisioning), resolve settles an item synchronously, and reauthorize sends
// the owning employee a notification pointing at the migration settings tab.
// Like the admin audit endpoints these check the admin flag directly instead
// of requireAdmin, which is coupled to the Employee Manager module.

const (
	migrationStatusNeedsAuth   = "needs_auth"
	migrationStatusNeedsReview = "needs_review"
)

// migrationItemRef is the decoded form of AdminMigrationItem.ID.
type migrationItemRef struct {
	sid, kind, sourceID string
}

func encodeMigrationItemID(ref migrationItemRef) string {
	return base64.RawURLEncoding.EncodeToString([]byte(ref.sid + "\n" + ref.kind + "\n" + ref.sourceID))
}

func decodeMigrationItemID(raw string) (migrationItemRef, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) > 1024 {
		return migrationItemRef{}, errors.New("invalid migration item id")
	}
	parts := strings.Split(string(decoded), "\n")
	if len(parts) != 3 || !strings.HasPrefix(parts[0], "S-1-") || parts[2] == "" {
		return migrationItemRef{}, errors.New("invalid migration item id")
	}
	switch parts[1] {
	case "skill", "mcp_server", "preset", "skill_binding", "mcp_binding":
	default:
		return migrationItemRef{}, errors.New("invalid migration item id")
	}
	return migrationItemRef{sid: parts[0], kind: parts[1], sourceID: parts[2]}, nil
}

// runtimeMigrationResult mirrors skillmigration.Result's JSON shape.
type runtimeMigrationResult struct {
	SourceID string `json:"sourceId"`
	TargetID string `json:"targetId,omitempty"`
	Kind     string `json:"kind"`
	Status   string `json:"status"`
	Reason   string `json:"reason,omitempty"`
}

// migrationRuntimeRequest performs one authenticated call against an employee
// runtime gateway. On a non-2xx status it returns the runtime's error code.
func (s *Server) migrationRuntimeRequest(ctx context.Context, sid, method, path string, timeout time.Duration, body any, out any) (string, error) {
	endpoint, err := s.runtimes.Resolve(ctx, sid)
	if err != nil {
		return "runtime_unavailable", err
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return "invalid_migration_disposition", err
		}
		reader = bytes.NewReader(payload)
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: path})
	downstream, err := http.NewRequestWithContext(ctx, method, target.String(), reader)
	if err != nil {
		return "runtime_unavailable", err
	}
	downstream.Header.Set("Authorization", "Bearer "+endpoint.Token)
	if body != nil {
		downstream.Header.Set("Content-Type", "application/json")
	}
	setCorrelationHeader(downstream)
	response, err := (&http.Client{Timeout: timeout}).Do(downstream)
	if err != nil {
		return "runtime_unreachable", err
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		if out == nil {
			return "", nil
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(out); err != nil {
			return "invalid_runtime_response", err
		}
		return "", nil
	}
	var failure struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&failure)
	if failure.Error == "" {
		failure.Error = "migration_disposition_failed"
	}
	return failure.Error, errors.New(failure.Error)
}

// runtimeMigrationResults fetches the journaled migration results of one
// employee runtime. ok is false when the runtime is not registered or does
// not answer.
func (s *Server) runtimeMigrationResults(ctx context.Context, sid string) (results []runtimeMigrationResult, ok bool) {
	var report struct {
		Results []runtimeMigrationResult `json:"results"`
	}
	if _, err := s.migrationRuntimeRequest(ctx, sid, http.MethodGet, "/v1/migrations/skills-mcp", 3*time.Second, nil, &report); err != nil {
		return nil, false
	}
	return report.Results, true
}

func (s *Server) adminMigrations(writer http.ResponseWriter, request *http.Request, user store.User) {
	if !user.Admin {
		writeError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	parameters := request.URL.Query()
	status := parameters.Get("status")
	if status != "" && status != migrationStatusNeedsAuth && status != migrationStatusNeedsReview {
		writeError(writer, http.StatusBadRequest, "invalid_migration_filter")
		return
	}
	sid := strings.TrimSpace(parameters.Get("sid"))
	employees, err := s.store.ListManagedUsers(request.Context())
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "migration_inventory_failed")
		return
	}
	items := []contracts.AdminMigrationItem{}
	unreachable := []string{}
	for _, employee := range employees {
		if sid != "" && !strings.EqualFold(employee.SID, sid) {
			continue
		}
		results, ok := s.runtimeMigrationResults(request.Context(), employee.SID)
		if !ok {
			unreachable = append(unreachable, employee.SID)
			continue
		}
		for _, result := range results {
			if result.Status != migrationStatusNeedsAuth && result.Status != migrationStatusNeedsReview {
				continue
			}
			if status != "" && result.Status != status {
				continue
			}
			ref := migrationItemRef{sid: employee.SID, kind: result.Kind, sourceID: result.SourceID}
			items = append(items, contracts.AdminMigrationItem{
				ID: encodeMigrationItemID(ref), SID: employee.SID, Username: employee.Username,
				SourceID: result.SourceID, TargetID: result.TargetID, Kind: result.Kind, Status: result.Status, Reason: result.Reason,
			})
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "items": items, "unreachable_sids": unreachable})
}

// migrationDispositionItem rebuilds the response item after a runtime
// disposition, refreshing the username best-effort.
func (s *Server) migrationDispositionItem(ctx context.Context, ref migrationItemRef, result runtimeMigrationResult) contracts.AdminMigrationItem {
	username := ""
	if employee, err := s.store.UserBySID(ctx, ref.sid); err == nil {
		username = employee.Username
	}
	return contracts.AdminMigrationItem{
		ID: encodeMigrationItemID(ref), SID: ref.sid, Username: username,
		SourceID: result.SourceID, TargetID: result.TargetID, Kind: result.Kind, Status: result.Status, Reason: result.Reason,
	}
}

func (s *Server) adminMigrationResolve(writer http.ResponseWriter, request *http.Request, user store.User) {
	if !user.Admin {
		writeError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	ref, err := decodeMigrationItemID(request.PathValue("id"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_migration_item")
		return
	}
	var outcome struct {
		Result runtimeMigrationResult `json:"result"`
	}
	code, err := s.migrationRuntimeRequest(request.Context(), ref.sid, http.MethodPost, "/v1/migrations/resolve", 15*time.Second,
		map[string]string{"kind": ref.kind, "sourceId": ref.sourceID}, &outcome)
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionMigrationDispositionResolve, ref.sid+":"+ref.sourceID, err, map[string]string{"kind": ref.kind, "sid": ref.sid})
	if err != nil {
		writeMigrationDispositionFailure(writer, code)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "item": s.migrationDispositionItem(request.Context(), ref, outcome.Result)})
}

func (s *Server) adminMigrationRetry(writer http.ResponseWriter, request *http.Request, user store.User) {
	if !user.Admin {
		writeError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	ref, err := decodeMigrationItemID(request.PathValue("id"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_migration_item")
		return
	}
	// Re-projection crosses two network hops and can take seconds, so it runs
	// as a background job the browser polls, like employee provisioning.
	job := s.migrationJobs.start(context.WithoutCancel(request.Context()), func(ctx context.Context) (*contracts.AdminMigrationItem, string, error) {
		var outcome struct {
			Result runtimeMigrationResult `json:"result"`
		}
		code, err := s.migrationRuntimeRequest(ctx, ref.sid, http.MethodPost, "/v1/migrations/retry", 60*time.Second,
			map[string]string{"kind": ref.kind, "sourceId": ref.sourceID}, &outcome)
		s.recordBusinessEvent(ctx, user.Username, audit.ActionMigrationDispositionRetry, ref.sid+":"+ref.sourceID, err, map[string]string{"kind": ref.kind, "sid": ref.sid})
		if err != nil {
			return nil, code, err
		}
		item := s.migrationDispositionItem(ctx, ref, outcome.Result)
		return &item, "", nil
	})
	writeJSON(writer, http.StatusAccepted, map[string]any{"success": true, "job": job})
}

func (s *Server) adminMigrationReauthorize(writer http.ResponseWriter, request *http.Request, user store.User) {
	if !user.Admin {
		writeError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	if s.modules.Notifications == nil {
		writeError(writer, http.StatusServiceUnavailable, "notifications_unavailable")
		return
	}
	ref, err := decodeMigrationItemID(request.PathValue("id"))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_migration_item")
		return
	}
	// Re-authorization is the employee's interactive OAuth flow; verify the
	// item still waits for it before nudging them.
	results, ok := s.runtimeMigrationResults(request.Context(), ref.sid)
	if !ok {
		writeError(writer, http.StatusServiceUnavailable, "runtime_unavailable")
		return
	}
	current := ""
	for _, result := range results {
		if result.SourceID == ref.sourceID && result.Kind == ref.kind {
			current = result.Status
			break
		}
	}
	if current == "" {
		writeError(writer, http.StatusNotFound, "migration_item_not_found")
		return
	}
	if current != migrationStatusNeedsAuth {
		writeError(writer, http.StatusConflict, "migration_item_not_needs_auth")
		return
	}
	s.publishNotification(request.Context(), contracts.NotificationInput{
		TargetSID: ref.sid, Kind: "migration_reauth",
		Title:    "Migration re-authorization requested",
		Message:  "An administrator asked you to re-authorize migrated item " + ref.sourceID + "; open the migration settings to complete sign-in.",
		DeepLink: "/settings/ext/workagent-migration",
	})
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionMigrationDispositionReauthorize, ref.sid+":"+ref.sourceID, nil, map[string]string{"kind": ref.kind, "sid": ref.sid})
	writeJSON(writer, http.StatusOK, map[string]bool{"success": true})
}

func (s *Server) adminMigrationJob(writer http.ResponseWriter, request *http.Request, user store.User) {
	if !user.Admin {
		writeError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	id := request.URL.Query().Get("id")
	if id == "" || len(request.URL.Query()) != 1 {
		writeError(writer, http.StatusBadRequest, "invalid_migration_job")
		return
	}
	job, ok := s.migrationJobs.get(id)
	if !ok {
		writeError(writer, http.StatusNotFound, "migration_job_not_found")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "job": job})
}

func writeMigrationDispositionFailure(writer http.ResponseWriter, code string) {
	switch code {
	case "runtime_unavailable", "runtime_unreachable":
		writeError(writer, http.StatusServiceUnavailable, code)
	case "migration_item_not_found":
		writeError(writer, http.StatusNotFound, code)
	case "migration_item_settled", "migration_item_no_target", "migration_item_not_needs_auth":
		writeError(writer, http.StatusConflict, code)
	case "migration_projection_failed", "preset_projection_unavailable":
		writeError(writer, http.StatusBadGateway, code)
	default:
		writeError(writer, http.StatusBadGateway, "migration_disposition_failed")
	}
}

// migrationJobTracker keeps the asynchronous disposition jobs in memory; the
// Portal is the admin console's only job owner, so no cross-process journal
// is needed. Terminal jobs are pruned once the tracker grows past 128.
type migrationJobTracker struct {
	mu   sync.Mutex
	jobs map[string]contracts.MigrationDispositionJob
}

func newMigrationJobTracker() *migrationJobTracker {
	return &migrationJobTracker{jobs: map[string]contracts.MigrationDispositionJob{}}
}

func (t *migrationJobTracker) start(ctx context.Context, run func(ctx context.Context) (*contracts.AdminMigrationItem, string, error)) contracts.MigrationDispositionJob {
	id, err := auth.RandomToken(18)
	if err != nil {
		return contracts.MigrationDispositionJob{Status: "failed", Percent: 100, Step: "failed", ErrorCode: "internal_error"}
	}
	job := contracts.MigrationDispositionJob{ID: id, Status: "running", Percent: 5, Step: "queued"}
	t.mu.Lock()
	t.pruneLocked()
	t.jobs[id] = job
	t.mu.Unlock()
	go func() {
		item, code, runErr := run(ctx)
		t.mu.Lock()
		defer t.mu.Unlock()
		job = t.jobs[id]
		job.Percent = 100
		if runErr != nil {
			job.Status = "failed"
			job.Step = "failed"
			job.ErrorCode = code
		} else {
			job.Status = "succeeded"
			job.Step = "completed"
			job.Item = item
		}
		t.jobs[id] = job
	}()
	return job
}

func (t *migrationJobTracker) pruneLocked() {
	if len(t.jobs) < 128 {
		return
	}
	for id, job := range t.jobs {
		if job.Status == "succeeded" || job.Status == "failed" {
			delete(t.jobs, id)
		}
	}
}

func (t *migrationJobTracker) get(id string) (contracts.MigrationDispositionJob, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	job, ok := t.jobs[id]
	return job, ok
}
