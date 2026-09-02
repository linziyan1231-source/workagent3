package audit

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

func TestAuditListFiltersAndMetadataRoundTrip(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return base }
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "alice", Target: "proj-1", Action: ActionCollaborationACLGrant, Result: "success", CorrelationID: "corr-1", Metadata: map[string]string{"member_sid": "S-1-5-21-7"}}); err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return base.Add(time.Hour) }
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "alice", Target: "proj-2", Action: ActionCollaborationACLRevoke, Result: "failure", CorrelationID: "corr-2"}); err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return base.Add(2 * time.Hour) }
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "bob", Target: "proj-1", Action: ActionCollaborationACLGrant, Result: "success", CorrelationID: "corr-3"}); err != nil {
		t.Fatal(err)
	}

	byAction, err := store.List(ctx, contracts.AuditQuery{Action: ActionCollaborationACLGrant})
	if err != nil || len(byAction) != 2 {
		t.Fatalf("action filter events=%#v err=%v", byAction, err)
	}
	byTarget, err := store.List(ctx, contracts.AuditQuery{Target: "proj-1"})
	if err != nil || len(byTarget) != 2 {
		t.Fatalf("target filter events=%#v err=%v", byTarget, err)
	}
	if byTarget[1].Metadata["member_sid"] != "S-1-5-21-7" {
		t.Fatalf("metadata did not round-trip: %#v", byTarget[1].Metadata)
	}
	byWindow, err := store.List(ctx, contracts.AuditQuery{From: base.Add(30 * time.Minute), To: base.Add(90 * time.Minute)})
	if err != nil || len(byWindow) != 1 || byWindow[0].Target != "proj-2" {
		t.Fatalf("time window events=%#v err=%v", byWindow, err)
	}
	combined, err := store.List(ctx, contracts.AuditQuery{Actor: "alice", Action: ActionCollaborationACLGrant, Target: "proj-1"})
	if err != nil || len(combined) != 1 || combined[0].CorrelationID != "corr-1" {
		t.Fatalf("combined filter events=%#v err=%v", combined, err)
	}
}

func TestAuditStoreMetadataIsBounded(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "a", Action: "x.y.z", Result: "success", CorrelationID: "c", Metadata: map[string]string{"api_token": "value"}}); err != nil {
		t.Fatalf("metadata with a sensitive-looking key is stored (redaction happens on export): %v", err)
	}
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "a", Action: "x.y.z", Result: "success", CorrelationID: "c", Metadata: map[string]string{"k": strings.Repeat("v", 513)}}); err == nil {
		t.Fatal("oversized metadata value was accepted")
	}
	tooMany := map[string]string{}
	for index := 0; index < 33; index++ {
		tooMany[string(rune('a'+index%26))+string(rune('0'+index/26))] = "v"
	}
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "a", Action: "x.y.z", Result: "success", CorrelationID: "c", Metadata: tooMany}); err == nil {
		t.Fatal("too many metadata entries were accepted")
	}
}

func TestAuditPruneRemovesOnlyExpiredEvents(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	base := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return base }
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "old", Action: "backup.create", Result: "success", CorrelationID: "c-old"}); err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return base.Add(200 * 24 * time.Hour) }
	if _, err := store.Record(ctx, contracts.AuditInput{Actor: "new", Action: "backup.create", Result: "success", CorrelationID: "c-new"}); err != nil {
		t.Fatal(err)
	}
	removed, err := store.Prune(ctx, base.Add(180*24*time.Hour))
	if err != nil || removed != 1 {
		t.Fatalf("removed=%d err=%v", removed, err)
	}
	remaining, err := store.List(ctx, contracts.AuditQuery{})
	if err != nil || len(remaining) != 1 || remaining[0].Actor != "new" {
		t.Fatalf("remaining=%#v err=%v", remaining, err)
	}
}

func TestRedactEventsMasksSensitiveMetadata(t *testing.T) {
	events := []contracts.AuditEvent{{
		ID: "audit-1", Actor: "alice", Target: "t", Action: "quota.reserve", Result: "success", CorrelationID: "c",
		Metadata: map[string]string{
			"model_id":     "codex-native",
			"access_token": "secret-value",
			"plain":        "prefix cpa_abcdefghijklmnopqrstuvwxyz suffix",
		},
	}}
	redacted := RedactEvents(events)
	if redacted[0].Metadata["model_id"] != "codex-native" {
		t.Fatalf("safe metadata was masked: %#v", redacted[0].Metadata)
	}
	if redacted[0].Metadata["access_token"] != "[redacted]" {
		t.Fatalf("sensitive key was not masked: %#v", redacted[0].Metadata)
	}
	if strings.Contains(redacted[0].Metadata["plain"], "cpa_") {
		t.Fatalf("plain key material survived redaction: %#v", redacted[0].Metadata)
	}
	// The input slice must not be mutated.
	if events[0].Metadata["access_token"] != "secret-value" {
		t.Fatal("RedactEvents mutated its input")
	}
}

func TestRecordCLIMapsResultAndNeverFails(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	RecordCLI(ctx, store, "release-manager", ActionReleaseActivate, "1.2.3", nil, map[string]string{"version": "1.2.3"})
	RecordCLI(ctx, store, "release-manager", ActionReleaseRollback, "1.2.3", errors.New("gate rejected"), nil)
	RecordCLI(ctx, nil, "release-manager", ActionReleaseInstall, "1.2.3", nil, nil)
	events, err := store.List(ctx, contracts.AuditQuery{Actor: "release-manager"})
	if err != nil || len(events) != 2 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	results := map[string]string{}
	for _, event := range events {
		results[event.Action] = event.Result
		if event.Target != "1.2.3" || event.CorrelationID == "" {
			t.Fatalf("unexpected event: %#v", event)
		}
	}
	if results[ActionReleaseActivate] != "success" || results[ActionReleaseRollback] != "failure" {
		t.Fatalf("results=%#v", results)
	}
}

type runtimeAuthorizerStub struct{ credential string }

func (s runtimeAuthorizerStub) RuntimeRegistrationAuthorized(_ context.Context, sid, credential string) bool {
	return sid == "S-1-5-21-100" && credential == s.credential
}

func TestRuntimeHandlerAuthenticatesAndForcesActor(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	handler := RuntimeHandler(store, runtimeAuthorizerStub{credential: "runtime-credential"})

	send := func(body string, credential string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/runtime/audit", strings.NewReader(body))
		request.RemoteAddr = "127.0.0.1:43210"
		if credential != "" {
			request.Header.Set("Authorization", "Bearer "+credential)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	if denied := send(`{"sid":"S-1-5-21-100","target":"skill-1","action":"skill.install","result":"success"}`, "wrong"); denied.Code != http.StatusUnauthorized {
		t.Fatalf("wrong credential status=%d", denied.Code)
	}
	if invalid := send(`{"sid":"S-1-5-21-100","target":"skill-1","action":"skill.install","result":"maybe"}`, "runtime-credential"); invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid result status=%d", invalid.Code)
	}
	accepted := send(`{"sid":"S-1-5-21-100","target":"skill-1","action":"skill.install","result":"success","metadata":{"skill_name":"pdf"}}`, "runtime-credential")
	if accepted.Code != http.StatusNoContent {
		t.Fatalf("accepted status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	events, err := store.List(context.Background(), contracts.AuditQuery{Action: "skill.install"})
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	event := events[0]
	if event.Actor != "S-1-5-21-100" || event.Target != "skill-1" || event.Result != "success" || event.CorrelationID == "" || event.Metadata["skill_name"] != "pdf" {
		t.Fatalf("unexpected runtime event: %#v", event)
	}
}
