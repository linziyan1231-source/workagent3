package modelgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"workagent3/internal/contracts"
)

const testSID = "S-1-5-21-100-200-300-1017"

// fakeKeyPolicyPlugin emulates the cpa-key-policy plugin routes the client
// uses: GET/POST/PATCH/DELETE /keys, POST /keys/rotate, GET /aliases.
type fakeKeyPolicyPlugin struct {
	mu           sync.Mutex
	keys         map[string]keyWrite
	patches      []keyWrite
	patchStatus  int // HTTP status for PATCH /keys; 0 means apply
	deletes      []string
	deleteStatus int // HTTP status for DELETE /keys; 0 means 204
	rotations    int
}

func newFakeKeyPolicyPlugin(t *testing.T) (*fakeKeyPolicyPlugin, *httptest.Server) {
	t.Helper()
	plugin := &fakeKeyPolicyPlugin{keys: map[string]keyWrite{}}
	server := httptest.NewServer(http.HandlerFunc(plugin.serve))
	t.Cleanup(server.Close)
	return plugin, server
}

func (p *fakeKeyPolicyPlugin) serve(writer http.ResponseWriter, request *http.Request) {
	route := strings.TrimPrefix(request.URL.Path, "/v0/management/plugins/cpa-key-policy")
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case route == "/aliases" && request.Method == http.MethodGet:
		var aliases []map[string]any
		for _, alias := range []string{"gpt-5.6-luna", "gpt-5.6-sol", "kimi-for-coding", "kimi-k3"} {
			aliases = append(aliases, map[string]any{"alias": alias, "targets": []map[string]string{{"provider": "test", "target_model": alias}}})
		}
		writePluginJSON(writer, map[string]any{"aliases": aliases})
	case route == "/keys" && request.Method == http.MethodGet:
		keys := make([]keyWrite, 0, len(p.keys))
		for _, key := range p.keys {
			keys = append(keys, key)
		}
		writePluginJSON(writer, map[string]any{"keys": keys})
	case route == "/keys" && request.Method == http.MethodPost:
		var key keyWrite
		if json.NewDecoder(request.Body).Decode(&key) != nil || p.keys[key.ID].ID != "" {
			writer.WriteHeader(http.StatusConflict)
			return
		}
		p.keys[key.ID] = key
		writePluginJSON(writer, map[string]any{"plain_key": "cpa_" + strings.Repeat("created", 4)})
	case route == "/keys" && request.Method == http.MethodPatch:
		if p.patchStatus != 0 {
			writer.WriteHeader(p.patchStatus)
			return
		}
		var key keyWrite
		if json.NewDecoder(request.Body).Decode(&key) != nil || p.keys[key.ID].ID == "" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		p.keys[key.ID] = key
		p.patches = append(p.patches, key)
		writePluginJSON(writer, map[string]any{"key": key})
	case route == "/keys" && request.Method == http.MethodDelete:
		if p.deleteStatus != 0 {
			writer.WriteHeader(p.deleteStatus)
			return
		}
		var body struct {
			ID string `json:"id"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		delete(p.keys, body.ID)
		p.deletes = append(p.deletes, body.ID)
		writer.WriteHeader(http.StatusNoContent)
	case route == "/keys/rotate" && request.Method == http.MethodPost:
		p.rotations++
		writePluginJSON(writer, map[string]any{"plain_key": fmt.Sprintf("cpa_rotated-%014d", p.rotations)})
	default:
		writer.WriteHeader(http.StatusNotFound)
	}
}

func writePluginJSON(writer http.ResponseWriter, value any) {
	writer.Header().Set("Content-Type", "application/json")
	payload, _ := json.Marshal(value)
	_, _ = writer.Write(payload)
}

func newPluginClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	config := completeConfig(t)
	config.ManagementURL = server.URL + "/v0/management/plugins/cpa-key-policy"
	client, err := NewCLIProxy(config)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func (p *fakeKeyPolicyPlugin) seed(key keyWrite) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.keys[key.ID] = key
}

func seededPluginKeys() (string, string, keyWrite, keyWrite) {
	chatgptID, kimiID := keyPrefix(testSID)+"-chatgpt", keyPrefix(testSID)+"-kimi"
	chatgpt := keyWrite{ID: chatgptID, Name: "alice / ChatGPT-Codex", Enabled: true, RPM: 30, Models: []keyModel{{Alias: "gpt-5.6-sol", Provider: "test", TargetModel: "gpt-5.6-sol"}}, DailyLimitUSD: 40, WeeklyLimitUSD: 80, AllowModelsEndpoint: true}
	kimi := keyWrite{ID: kimiID, Name: "alice / Kimi", Enabled: true, RPM: 30, Models: []keyModel{{Alias: "kimi-k3", Provider: "test", TargetModel: "kimi-k3"}}, DailyLimitUSD: 10, WeeklyLimitUSD: 20, AllowModelsEndpoint: true}
	return chatgptID, kimiID, chatgpt, kimi
}

type recordingSink struct {
	mu     sync.Mutex
	events []contracts.AuditInput
	err    error
}

func (s *recordingSink) Record(_ context.Context, input contracts.AuditInput) (contracts.AuditEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, input)
	return contracts.AuditEvent{}, s.err
}

func TestSetKeysEnabledPatchesBothKeysPreservingPolicy(t *testing.T) {
	plugin, server := newFakeKeyPolicyPlugin(t)
	chatgptID, kimiID, chatgpt, kimi := seededPluginKeys()
	plugin.seed(chatgpt)
	plugin.seed(kimi)
	client := newPluginClient(t, server)
	if err := client.SetKeysEnabled(t.Context(), testSID, false); err != nil {
		t.Fatal(err)
	}
	if plugin.keys[chatgptID].Enabled || plugin.keys[kimiID].Enabled {
		t.Fatalf("keys were not disabled: %+v", plugin.keys)
	}
	for _, patch := range plugin.patches {
		if patch.Enabled || patch.RPM != 30 || len(patch.Models) != 1 || patch.DailyLimitUSD == 0 || patch.WeeklyLimitUSD == 0 || !patch.AllowModelsEndpoint {
			t.Fatalf("PATCH did not preserve the stored key policy: %+v", patch)
		}
	}
	// Replay: already disabled keys are skipped, so nothing changes.
	if err := client.SetKeysEnabled(t.Context(), testSID, false); err != nil {
		t.Fatal(err)
	}
	if len(plugin.patches) != 2 {
		t.Fatalf("idempotent replay issued extra PATCHes: %d", len(plugin.patches))
	}
	if err := client.SetKeysEnabled(t.Context(), testSID, true); err != nil {
		t.Fatal(err)
	}
	if !plugin.keys[chatgptID].Enabled || !plugin.keys[kimiID].Enabled {
		t.Fatalf("keys were not re-enabled: %+v", plugin.keys)
	}
	// Unknown SID has no keys: no-op success, no PATCH.
	if err := client.SetKeysEnabled(t.Context(), "S-1-5-21-999", false); err != nil {
		t.Fatal(err)
	}
	if err := client.SetKeysEnabled(t.Context(), "not-a-sid", false); err == nil {
		t.Fatal("invalid SID was accepted")
	}
}

func TestRevokeKeysDeletesAndIsIdempotent(t *testing.T) {
	plugin, server := newFakeKeyPolicyPlugin(t)
	_, _, chatgpt, kimi := seededPluginKeys()
	plugin.seed(chatgpt)
	plugin.seed(kimi)
	client := newPluginClient(t, server)
	if err := client.RevokeKeys(t.Context(), testSID); err != nil {
		t.Fatal(err)
	}
	if len(plugin.keys) != 0 || len(plugin.deletes) != 2 {
		t.Fatalf("keys were not deleted: keys=%v deletes=%v", plugin.keys, plugin.deletes)
	}
	if err := client.RevokeKeys(t.Context(), testSID); err != nil {
		t.Fatal(err)
	}
	if len(plugin.deletes) != 2 {
		t.Fatalf("idempotent replay issued extra DELETEs: %v", plugin.deletes)
	}
	if err := client.RevokeKeys(t.Context(), "not-a-sid"); err == nil {
		t.Fatal("invalid SID was accepted")
	}
}

func TestRevokeKeysFallsBackToDisableWhenDeletionUnsupported(t *testing.T) {
	plugin, server := newFakeKeyPolicyPlugin(t)
	chatgptID, kimiID, chatgpt, kimi := seededPluginKeys()
	plugin.seed(chatgpt)
	plugin.seed(kimi)
	plugin.deleteStatus = http.StatusMethodNotAllowed
	client := newPluginClient(t, server)
	if err := client.RevokeKeys(t.Context(), testSID); err != nil {
		t.Fatal(err)
	}
	if plugin.keys[chatgptID].Enabled || plugin.keys[kimiID].Enabled {
		t.Fatalf("unsupported deletion did not fall back to disabling keys: %+v", plugin.keys)
	}
	if len(plugin.patches) != 2 {
		t.Fatalf("fallback did not PATCH both keys: %d", len(plugin.patches))
	}
}

func TestKeyOperationsWriteBusinessAudit(t *testing.T) {
	plugin, server := newFakeKeyPolicyPlugin(t)
	chatgptID, kimiID, chatgpt, kimi := seededPluginKeys()
	plugin.seed(chatgpt)
	plugin.seed(kimi)
	sink := &recordingSink{}
	client := newPluginClient(t, server)
	client.SetAudit(sink, "employee-manager")
	if err := client.SetKeysEnabled(t.Context(), testSID, false); err != nil {
		t.Fatal(err)
	}
	if err := client.RevokeKeys(t.Context(), testSID); err != nil {
		t.Fatal(err)
	}
	if len(sink.events) != 4 {
		t.Fatalf("audit events = %d, want 4", len(sink.events))
	}
	correlations := map[string]int{}
	for index, event := range sink.events {
		if event.Actor != "employee-manager" || event.Result != "success" || event.CorrelationID == "" {
			t.Fatalf("audit event %d is incomplete: %+v", index, event)
		}
		correlations[event.CorrelationID]++
	}
	if sink.events[0].Action != "modelgateway.key.disable" || sink.events[1].Action != "modelgateway.key.disable" {
		t.Fatalf("disable actions are wrong: %+v", sink.events[:2])
	}
	if sink.events[2].Action != "modelgateway.key.revoke" || sink.events[3].Action != "modelgateway.key.revoke" {
		t.Fatalf("revoke actions are wrong: %+v", sink.events[2:])
	}
	targets := map[string]bool{}
	for _, event := range sink.events {
		targets[event.Target] = true
	}
	if !targets[chatgptID] || !targets[kimiID] {
		t.Fatalf("audit targets are not the managed key IDs: %v", targets)
	}
	if len(correlations) != 2 {
		t.Fatalf("each operation must share one correlation ID: %v", correlations)
	}
}

func TestKeyOperationAuditFailureDoesNotFailOperation(t *testing.T) {
	plugin, server := newFakeKeyPolicyPlugin(t)
	_, _, chatgpt, kimi := seededPluginKeys()
	plugin.seed(chatgpt)
	plugin.seed(kimi)
	sink := &recordingSink{err: fmt.Errorf("audit database locked")}
	client := newPluginClient(t, server)
	client.SetAudit(sink, "employee-manager")
	if err := client.SetKeysEnabled(t.Context(), testSID, false); err != nil {
		t.Fatalf("audit recording failure failed the key operation: %v", err)
	}
}

func TestFailedKeyOperationRecordsFailureAudit(t *testing.T) {
	plugin, server := newFakeKeyPolicyPlugin(t)
	chatgptID, _, chatgpt, _ := seededPluginKeys()
	plugin.seed(chatgpt)
	plugin.patchStatus = http.StatusInternalServerError
	sink := &recordingSink{}
	client := newPluginClient(t, server)
	client.SetAudit(sink, "employee-manager")
	if err := client.SetKeysEnabled(t.Context(), testSID, false); err == nil {
		t.Fatal("failing plugin disabled keys")
	}
	if len(sink.events) != 1 {
		t.Fatalf("audit events = %d, want 1", len(sink.events))
	}
	event := sink.events[0]
	if event.Action != "modelgateway.key.disable" || event.Result != "failure" || event.Target != chatgptID {
		t.Fatalf("failure audit event is wrong: %+v", event)
	}
}

func TestProvisionAuditsProvisionThenRotate(t *testing.T) {
	_, server := newFakeKeyPolicyPlugin(t)
	sink := &recordingSink{}
	client := newPluginClient(t, server)
	client.SetAudit(sink, "employee-manager")
	bundle, err := client.Provision(t.Context(), "alice", testSID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(bundle.KimiModels, ",") != strings.Join(client.config.KimiModels, ",") {
		t.Fatal("authorized Kimi roster was lost during bootstrap provisioning")
	}
	if _, err := client.Provision(t.Context(), "alice", testSID); err != nil {
		t.Fatal(err)
	}
	if len(sink.events) != 4 {
		t.Fatalf("audit events = %d, want 4", len(sink.events))
	}
	for index, event := range sink.events {
		want := "modelgateway.key.provision"
		if index >= 2 {
			want = "modelgateway.key.rotate"
		}
		if event.Action != want || event.Result != "success" {
			t.Fatalf("audit event %d = %+v, want action %s", index, event, want)
		}
	}
	if sink.events[0].CorrelationID == sink.events[2].CorrelationID {
		t.Fatal("separate provisions must not share a correlation ID")
	}
}
