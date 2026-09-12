package portal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"workagent3/internal/contracts"
	"workagent3/internal/notifications"
	"workagent3/internal/runtimeapi"
)

type groupModelAccess struct{}

func legacyAssistantCatalog(t *testing.T) StaticRouter {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/model-options" {
			writeSharedModelFixture(w)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"codex","name":"Codex","engine":"codex","enabled":true}]`))
	}))
	t.Cleanup(server.Close)
	endpoint, _ := url.Parse(server.URL)
	return StaticRouter{"S-1-5-21-1000": runtimeapi.Endpoint{BaseURL: endpoint, Token: "fixture-token"}}
}

func (groupModelAccess) ListAuthorized(context.Context, string) ([]contracts.AuthorizedModel, error) {
	return []contracts.AuthorizedModel{
		{Model: contracts.Model{ID: "gpt-5", ProviderID: "codex"}, Authorization: contracts.ModelAuthorization{Authorized: true}},
		{Model: contracts.Model{ID: "kimi-2", ProviderID: "kimi"}, Authorization: contracts.ModelAuthorization{Authorized: true}},
	}, nil
}

type groupTurnFixture struct {
	requests chan SharedTurnRequest
	release  chan struct{}
}

func (f *groupTurnFixture) Run(ctx context.Context, _ string, r SharedTurnRequest) (SharedTurnResult, error) {
	f.requests <- r
	select {
	case <-ctx.Done():
		return SharedTurnResult{}, ctx.Err()
	case <-f.release:
	}
	return SharedTurnResult{RunID: r.RunID, RuntimeSessionID: r.SessionKey, AssistantBody: r.AssistantID + " group reply"}, nil
}
func (*groupTurnFixture) Cancel(context.Context, string, string) error { return nil }

func TestSharedAssistantInvitationsMentionsSettingsAndParallelDispatch(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.URL.Path != "/v1/presets" && r.URL.Path != "/v1/model-options") || r.Header.Get("Authorization") != "Bearer owner-runtime-token" {
			t.Error("incorrect catalog routing")
		}
		if r.URL.Path == "/v1/model-options" {
			writeSharedModelFixture(w)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"builtin-codex","name":"Codex","engine":"codex","enabled":true},{"id":"builtin-kimi","name":"Kimi","engine":"kimi","enabled":true},{"id":"disabled","name":"Disabled","engine":"codex","enabled":false}]`))
	}))
	defer upstream.Close()
	endpoint, _ := url.Parse(upstream.URL)
	runner := &groupTurnFixture{requests: make(chan SharedTurnRequest, 8), release: make(chan struct{})}
	defer func() {
		select {
		case <-runner.release:
		default:
			close(runner.release)
		}
	}()
	notices, err := notifications.Open(filepath.Join(t.TempDir(), "notices.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer notices.Close()
	handler, data, _, alice, bob := collaborationTestServer(t, func(s *Server) {
		s.runtimes = StaticRouter{"S-1-5-21-1000": runtimeapi.Endpoint{BaseURL: endpoint, Token: "owner-runtime-token"}}
		s.modules.ModelAccess = groupModelAccess{}
		s.modules.SharedTurns = runner
		s.modules.Notifications = notices
	})
	call := func(session, method, path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := collaborationRequest(t, handler, session, method, path, body)
		if r.Code != want {
			t.Fatalf("%s %s: %d %s", method, path, r.Code, r.Body.String())
		}
		return r
	}
	created := call(alice.session, "POST", "/api/portal/shared-projects", `{"name":"Group agents"}`, 201)
	var group struct {
		Project      sharedProjectDTO      `json:"project"`
		Conversation sharedConversationDTO `json:"conversation"`
	}
	json.Unmarshal(created.Body.Bytes(), &group)
	base := "/api/portal/shared-projects/" + group.Project.ID
	invited := call(alice.session, "POST", base+"/invites", `{"targetUsername":"bob"}`, 201)
	var human struct {
		Invite sharedInviteDTO `json:"invite"`
	}
	json.Unmarshal(invited.Body.Bytes(), &human)
	call(bob.session, "POST", "/api/portal/shared-invites/"+human.Invite.ID+"/accept", `{}`, 200)
	options := call(alice.session, "GET", base+"/assistant-options", "", 200)
	if strings.Contains(options.Body.String(), "disabled") {
		t.Fatal("disabled assistant offered")
	}
	call(bob.session, "POST", base+"/assistant-invites", `{"assistant_id":"builtin-kimi"}`, 403)
	call(alice.session, "POST", "/api/portal/shared-conversations", `{"project_id":"`+group.Project.ID+`","name":"Bypass","assistant_id":"builtin-kimi","assistant_backend":"kimi","model_id":"kimi-2","thinking_effort":"low"}`, 400)
	message := func(id string, ids ...string) string {
		mentions := []map[string]string{{"kind": "member", "id": fmt.Sprint(bob.user.ID)}}
		for _, id := range ids {
			mentions = append(mentions, map[string]string{"kind": "assistant", "id": id})
		}
		encoded, _ := json.Marshal(map[string]any{"conversation_id": group.Conversation.ID, "body": "All discuss this plan", "client_message_id": id, "mentions": mentions})
		return string(encoded)
	}
	call(alice.session, "POST", "/api/portal/shared-messages", message("message-unjoined-001", "builtin-kimi"), 400)
	for _, id := range []string{"builtin-codex", "builtin-kimi"} {
		response := call(alice.session, "POST", base+"/assistant-invites", `{"assistant_id":"`+id+`"}`, 201)
		if !strings.Contains(response.Body.String(), `"status":"accepted"`) {
			t.Fatal(response.Body.String())
		}
	}
	select {
	case <-runner.requests:
		t.Fatal("invitation executed assistant")
	default:
	}
	call(alice.session, "POST", base+"/assistant-invites", `{"assistant_id":"builtin-kimi"}`, 409)
	call(alice.session, "PATCH", base+"/assistants/builtin-kimi", `{"model_id":"kimi-2","thinking_effort":"high","assistant_backend":"codex"}`, 400)
	call(alice.session, "PATCH", base+"/assistants/builtin-kimi", `{"model_id":"gpt-5","thinking_effort":"high"}`, 403)
	call(alice.session, "PATCH", base+"/assistants/builtin-kimi", `{"model_id":"kimi-2","thinking_effort":"high"}`, 200)
	body := message("message-both-agents-001", "builtin-codex", "builtin-kimi")
	sent := call(alice.session, "POST", "/api/portal/shared-messages", body, 201)
	var sentBody struct {
		Message    sharedMessageDTO         `json:"message"`
		Assistants []sharedAssistantOutcome `json:"assistants"`
	}
	json.Unmarshal(sent.Body.Bytes(), &sentBody)
	if len(sentBody.Assistants) != 2 {
		t.Fatal(sent.Body.String())
	}
	requests := map[string]SharedTurnRequest{}
	for range 2 {
		select {
		case r := <-runner.requests:
			requests[r.AssistantID] = r
		case <-time.After(5 * time.Second):
			t.Fatal("missing assistant execution")
		}
	}
	if requests["builtin-codex"].SessionKey == requests["builtin-kimi"].SessionKey {
		t.Fatal("shared session key")
	}
	call(alice.session, "POST", "/api/portal/shared-messages", body, 200)
	select {
	case <-runner.requests:
		t.Fatal("retry repeated execution")
	default:
	}
	call(alice.session, "PATCH", base+"/assistants/builtin-kimi", `{"model_id":"kimi-2","thinking_effort":"low"}`, 409)
	notification := call(bob.session, "GET", "/api/portal/me/notifications", "", 200)
	if !strings.Contains(notification.Body.String(), "message="+sentBody.Message.ID) {
		t.Fatal("mention notification lacks message target: " + notification.Body.String())
	}
	close(runner.release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		view, err := data.ConversationForUser(t.Context(), group.Conversation.ID, alice.user.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		if view.State == "idle" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("replies did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	rows, err := data.ListMessages(t.Context(), group.Conversation.ID, alice.user.ID, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, m := range rows {
		if m.Kind == "assistant" {
			seen[m.AuthorAssistantID] = true
		}
	}
	if !seen["builtin-codex"] || !seen["builtin-kimi"] {
		t.Fatalf("reply attribution: %#v", rows)
	}
	call(alice.session, "DELETE", base+"/assistants/builtin-kimi", "", 204)
	call(alice.session, "POST", "/api/portal/shared-messages", message("message-removed-001", "builtin-kimi"), 400)
}

func writeSharedModelFixture(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`[{"engine":"codex","models":[{"id":"gpt-5","name":"GPT","isDefault":true,"reasoning":[{"id":"low","name":"Low"},{"id":"medium","name":"Medium"},{"id":"high","name":"High"}],"defaultReasoning":"medium"}]},{"engine":"kimi","models":[{"id":"kimi-2","name":"Kimi 2","isDefault":true,"reasoning":[{"id":"low","name":"Low"},{"id":"high","name":"High"},{"id":"max","name":"Max"}],"defaultReasoning":"low"}]}]`))
}

func TestSharedNativeModelsUseSupportedReasoningAndLogicalBilling(t *testing.T) {
	access := []contracts.AuthorizedModel{{Model: contracts.Model{ID: "kimi-native", ProviderID: "kimi"}, Authorization: contracts.ModelAuthorization{Authorized: true}}}
	catalog := []sharedEngineModels{{Engine: "kimi", Models: []sharedAssistantModel{{ID: "kimi-code/kimi-k3", Name: "Kimi K3", IsDefault: true, DefaultReasoning: "low", Reasoning: []sharedAssistantReasoning{{ID: "low"}, {ID: "high"}, {ID: "max"}}}}}}
	choices := sharedModelChoices(access, catalog, "kimi")
	model, effort, valid := sharedModelSelection(choices, "", "")
	if !valid || model != "kimi-code/kimi-k3" || effort != "low" {
		t.Fatalf("native default: %s %s %v", model, effort, valid)
	}
	if sharedBillingModel(access, "kimi", model) != "kimi-native" {
		t.Fatal("native selection changed quota identity")
	}
	if _, _, valid := sharedModelSelection(choices, model, "medium"); valid {
		t.Fatal("unsupported Kimi medium accepted")
	}
	if _, _, valid := sharedModelSelection(choices, model, "max"); !valid {
		t.Fatal("supported Kimi max rejected")
	}
	if _, _, valid := sharedModelSelection(choices, "kimi-native", "low"); !valid {
		t.Fatal("legacy model alias unavailable")
	}
	if len(sharedModelChoices(access, catalog, "codex")) != 0 {
		t.Fatal("cross-engine model access")
	}
}
