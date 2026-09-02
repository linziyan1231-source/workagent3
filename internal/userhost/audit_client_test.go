package userhost

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
	"workagent3/internal/skillruntime"
)

type auditAuthorizerStub struct{ sid, credential string }

func (s auditAuthorizerStub) RuntimeRegistrationAuthorized(_ context.Context, sid, credential string) bool {
	return sid == s.sid && credential == s.credential
}

// TestSkillDisableEventFlowsToPortalAudit covers the full runtime audit path:
// the UserHost handler records the business event, the audit client posts it
// to the Portal loopback endpoint, and the Portal stores it with the actor
// forced to the runtime's SID.
func TestSkillDisableEventFlowsToPortalAudit(t *testing.T) {
	sid := "S-1-5-21-100"
	auditStore, err := audit.Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { auditStore.Close() })
	portal := httptest.NewServer(audit.RuntimeHandler(auditStore, auditAuthorizerStub{sid: sid, credential: "registration-credential"}))
	t.Cleanup(portal.Close)

	client, err := newAuditClient(portal.URL, "registration-credential", sid)
	if err != nil {
		t.Fatal(err)
	}
	store := openGatewaySkills(t)
	source := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: user-skill\ndescription: User skill\n---\nskill"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Install(context.Background(), skillruntime.InstallInput{
		Entry: skillruntime.Entry{ID: "user-skill", Name: "User Skill", Version: "1", Source: "user", Enabled: true}, SourceDirectory: source,
	}); err != nil {
		t.Fatal(err)
	}
	catalog, err := openEmptyMCPCatalog(t)
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandlerWithControl(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, store, gatewayTestPublisher{}, nil, nil, target, "token", nil, nil, nil, "", nil, client, nil)

	request := httptest.NewRequest(http.MethodPatch, "/v1/skills/user-skill", strings.NewReader(`{"enabled":false}`))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("X-WorkAgent-Correlation-ID", "corr-skill-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("disable status=%d body=%s", response.Code, response.Body.String())
	}
	events, err := auditStore.List(context.Background(), contracts.AuditQuery{Action: audit.ActionSkillDisable})
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	event := events[0]
	if event.Actor != sid || event.Target != "user-skill" || event.Result != "success" || event.CorrelationID != "corr-skill-1" || event.Metadata["skill_name"] != "User Skill" {
		t.Fatalf("unexpected event: %#v", event)
	}
}

func TestAuditClientRejectsNonLoopbackPortal(t *testing.T) {
	if _, err := newAuditClient("https://portal.example.com", "credential", "S-1-5-21-100"); err == nil {
		t.Fatal("non-loopback Portal URL was accepted")
	}
	var nilClient *auditClient
	nilClient.Record(context.Background(), audit.ActionSkillEnable, "skill-1", "success", "", nil)
}

// TestMCPAndOAuthEventsFlowToPortalAudit covers MCP install/enable/disable/
// uninstall and the OAuth authorize/revoke failure paths.
func TestMCPAndOAuthEventsFlowToPortalAudit(t *testing.T) {
	sid := "S-1-5-21-100"
	auditStore, err := audit.Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { auditStore.Close() })
	portal := httptest.NewServer(audit.RuntimeHandler(auditStore, auditAuthorizerStub{sid: sid, credential: "registration-credential"}))
	t.Cleanup(portal.Close)
	client, err := newAuditClient(portal.URL, "registration-credential", sid)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := openEmptyMCPCatalog(t)
	if err != nil {
		t.Fatal(err)
	}
	credentials := openGatewayCredentials(t)
	publisher := gatewayTestPublisher{}
	oauth := newMCPOAuthManager(catalog, credentials, publisher)
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandlerWithControl(catalog, credentials, publisher, openGatewaySkills(t), publisher, nil, oauth, target, "runtime-token", nil, nil, nil, "", nil, client, nil)

	send := func(method, path, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer runtime-token")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	created := send(http.MethodPost, "/v1/mcp-servers", `{"name":"docs","source":"user","enabled":true,"transport":{"kind":"http","url":"https://example.com/mcp","headerCredentialIds":{}},"toolPolicy":"all","allowedTools":[],"oauthState":"none"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var server struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &server); err != nil || server.ID == "" {
		t.Fatalf("create body=%s err=%v", created.Body.String(), err)
	}
	if disabled := send(http.MethodPatch, "/v1/mcp-servers/"+server.ID, `{"enabled":false}`); disabled.Code != http.StatusOK {
		t.Fatalf("disable status=%d body=%s", disabled.Code, disabled.Body.String())
	}
	if removed := send(http.MethodDelete, "/v1/mcp-servers/"+server.ID, ""); removed.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", removed.Code, removed.Body.String())
	}
	// OAuth authorize and revoke failure paths (no pending flow, no grant).
	if authorized := send(http.MethodPost, "/v1/mcp-servers/"+server.ID+"/oauth/complete", `{"flowId":"missing","state":"s","code":"c"}`); authorized.Code != http.StatusBadRequest {
		t.Fatalf("complete status=%d body=%s", authorized.Code, authorized.Body.String())
	}
	if revoked := send(http.MethodDelete, "/v1/mcp-servers/"+server.ID+"/oauth", ""); revoked.Code != http.StatusBadRequest {
		t.Fatalf("logout status=%d body=%s", revoked.Code, revoked.Body.String())
	}

	events, err := auditStore.List(context.Background(), contracts.AuditQuery{})
	if err != nil {
		t.Fatal(err)
	}
	byAction := map[string][]contracts.AuditEvent{}
	for _, event := range events {
		if event.Actor != sid {
			t.Fatalf("event actor not forced to runtime SID: %#v", event)
		}
		byAction[event.Action] = append(byAction[event.Action], event)
	}
	expect := map[string]string{
		audit.ActionMCPInstall:        "success",
		audit.ActionMCPDisable:        "success",
		audit.ActionMCPUninstall:      "success",
		audit.ActionMCPOAuthAuthorize: "failure",
		audit.ActionMCPOAuthRevoke:    "failure",
	}
	for action, result := range expect {
		matching := byAction[action]
		if len(matching) != 1 || matching[0].Result != result || matching[0].Target != server.ID {
			t.Fatalf("action %s events=%#v", action, matching)
		}
	}
	if byAction[audit.ActionMCPInstall][0].Metadata["server_name"] != "docs" || byAction[audit.ActionMCPInstall][0].Metadata["transport"] != "http" {
		t.Fatalf("install metadata: %#v", byAction[audit.ActionMCPInstall][0].Metadata)
	}
}
