package modelgateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"workagent3/internal/contracts"
)

// fakeCLIProxy emulates the deployed CLIProxyAPI: the cpa-key-policy
// management plugin (alias catalog + downstream key lifecycle) and the
// OpenAI-compatible /v1/chat/completions downstream endpoint, whose model
// obeys the sentinel instruction from the probe prompt.
type fakeCLIProxy struct {
	server *httptest.Server
	mu     sync.Mutex
	keys   map[string]bool

	failManagement bool
	failTurn       bool
	sentinel       bool
}

var probeMarkerPattern = regexp.MustCompile(`WORKAGENT3_[A-Z]+_CLIPROXY_OK`)

func newFakeCLIProxy(t *testing.T) *fakeCLIProxy {
	t.Helper()
	fake := &fakeCLIProxy{keys: make(map[string]bool)}
	fake.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		switch {
		case request.URL.Path == "/v0/management/plugins/cpa-key-policy/aliases":
			if fake.failManagement {
				writer.WriteHeader(http.StatusInternalServerError)
				return
			}
			writeJSON(writer, map[string]any{"aliases": []map[string]any{
				{"alias": "gpt-5.6-sol", "targets": []map[string]any{{"provider": "chatgpt", "target_model": "gpt-5.6-sol"}}},
				{"alias": "kimi-k3", "targets": []map[string]any{{"provider": "kimi", "target_model": "kimi-k3"}}},
			}})
		case request.URL.Path == "/v0/management/plugins/cpa-key-policy/keys" && request.Method == http.MethodPost:
			var requested keyWrite
			if json.NewDecoder(request.Body).Decode(&requested) != nil || !strings.HasPrefix(requested.ID, "aionui-probe-") {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			fake.keys[requested.ID] = true
			writeJSON(writer, map[string]any{"plain_key": "cpa_probekey_" + requested.ID})
		case request.URL.Path == "/v0/management/plugins/cpa-key-policy/keys" && request.Method == http.MethodDelete:
			var body struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			delete(fake.keys, body.ID)
			writeJSON(writer, map[string]any{})
		case request.URL.Path == "/v1/chat/completions":
			var turn struct {
				Model    string `json:"model"`
				Messages []struct {
					Content string `json:"content"`
				} `json:"messages"`
			}
			_ = json.NewDecoder(request.Body).Decode(&turn)
			key := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
			if !strings.HasPrefix(key, "cpa_probekey_aionui-probe-") || fake.failTurn {
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
			content := "I cannot do that."
			if fake.sentinel && len(turn.Messages) == 1 {
				if marker := probeMarkerPattern.FindString(turn.Messages[0].Content); marker != "" {
					content = marker
				}
			}
			writeJSON(writer, map[string]any{"choices": []map[string]any{
				{"message": map[string]any{"role": "assistant", "content": content}},
			}})
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func writeJSON(writer http.ResponseWriter, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(payload)
}

func (f *fakeCLIProxy) client() *Client {
	return &Client{
		config: Config{
			BaseURL:       f.server.URL + "/v1",
			CodexModel:    "gpt-5.6-sol",
			CodexModels:   []string{"gpt-5.6-sol"},
			KimiModel:     "kimi-k3",
			KimiModels:    []string{"kimi-k3"},
			RPM:           30,
			CodexDailyUSD: 40, CodexWeeklyUSD: 80,
			KimiDailyUSD: 10, KimiWeeklyUSD: 20,
		},
		base: f.server.URL + "/v0/management/plugins/cpa-key-policy",
		key:  strings.Repeat("k", 40),
		http: f.server.Client(),
	}
}

func outcomesByEngine(outcomes []ProbeOutcome) map[string]ProbeOutcome {
	result := make(map[string]ProbeOutcome, len(outcomes))
	for _, outcome := range outcomes {
		result[outcome.Evidence.Engine] = outcome
	}
	return result
}

func TestRunReadinessProbesPassesWithRealTurns(t *testing.T) {
	fake := newFakeCLIProxy(t)
	fake.sentinel = true
	outcomes := fake.client().RunReadinessProbes(t.Context(), "3.0.0-rc.1", "run-abcdef123456")
	if len(outcomes) != 4 {
		t.Fatalf("expected four probe outcomes, got %d", len(outcomes))
	}
	byEngine := outcomesByEngine(outcomes)
	for _, engine := range []string{"cliproxy", "codex", "kimi", "harness"} {
		outcome, ok := byEngine[engine]
		if !ok || outcome.Err != nil {
			t.Fatalf("%s probe failed: %#v %v", engine, outcome, outcome.Err)
		}
		evidence := outcome.Evidence
		if evidence.Version != "3.0.0-rc.1" || evidence.RunID != "run-abcdef123456" ||
			evidence.Result != contracts.ProbeResultPass || !evidence.Redacted || evidence.CheckedAt.IsZero() {
			t.Fatalf("%s evidence is not the structured redacted shape: %#v", engine, evidence)
		}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.keys) != 0 {
		t.Fatalf("temporary probe keys were not revoked: %#v", fake.keys)
	}
}

func TestRunReadinessProbesFailsWhenManagementProbeFails(t *testing.T) {
	fake := newFakeCLIProxy(t)
	fake.failManagement = true
	outcomes := outcomesByEngine(fake.client().RunReadinessProbes(t.Context(), "3.0.0", "run-abcdef123456"))
	for _, engine := range []string{"cliproxy", "codex", "kimi", "harness"} {
		outcome := outcomes[engine]
		if outcome.Err == nil || outcome.Evidence.Result != contracts.ProbeResultFail {
			t.Fatalf("%s probe passed without a management API: %#v", engine, outcome)
		}
	}
}

func TestRunReadinessProbesFailsWithoutSentinelAnswer(t *testing.T) {
	fake := newFakeCLIProxy(t)
	outcomes := outcomesByEngine(fake.client().RunReadinessProbes(t.Context(), "3.0.0", "run-abcdef123456"))
	if outcomes["cliproxy"].Err != nil {
		t.Fatalf("management probe failed: %v", outcomes["cliproxy"].Err)
	}
	for _, engine := range []string{"codex", "kimi", "harness"} {
		outcome := outcomes[engine]
		if outcome.Err == nil || !strings.Contains(outcome.Err.Error(), "sentinel") {
			t.Fatalf("%s probe passed without the sentinel answer: %#v", engine, outcome)
		}
	}
}

func TestRunReadinessProbesFailsWhenGatewayRejectsProbeKey(t *testing.T) {
	fake := newFakeCLIProxy(t)
	fake.failTurn = true
	outcomes := outcomesByEngine(fake.client().RunReadinessProbes(t.Context(), "3.0.0", "run-abcdef123456"))
	for _, engine := range []string{"codex", "kimi", "harness"} {
		if outcomes[engine].Err == nil {
			t.Fatalf("%s probe passed with rejected probe keys", engine)
		}
	}
}
