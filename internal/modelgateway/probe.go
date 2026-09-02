package modelgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"workagent3/internal/contracts"
)

// ProbeOutcome couples the structured evidence of one real readiness probe
// with its error. The evidence never carries credentials, URLs, or error
// text; Err is for the operator console only and is never persisted.
type ProbeOutcome struct {
	Evidence contracts.ProbeEvidence
	Err      error
}

// probeTurnClient issues the model-round-trip requests. The management client
// keeps its 30-second ceiling; a model turn is allowed up to 90 seconds like
// the CLI smoke (scripts/smoke-cliproxy-native.mjs).
var probeTurnClient = &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}}

func init() {
	// The gateway is always the loopback CLIProxyAPI; never honor proxy env.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	probeTurnClient.Transport = transport
}

// RunReadinessProbes executes the release readiness gate against the deployed
// CLIProxyAPI with real requests, mirroring scripts/smoke-cliproxy-native.mjs:
//
//   - cliproxy: an authenticated management API round trip (alias catalog);
//   - codex/kimi: a real model turn through the gateway with a temporary
//     probe downstream key provisioned through the same cpa-key-policy
//     projection path employee keys use, requiring the exact sentinel answer;
//   - harness: the same real turn over the shared ChatGPT-side projection
//     (the Harness provider targets baseUrl with the configured harness
//     model, which is the managed CodexModel).
//
// Probe keys are revoked best-effort before returning. A failing probe yields
// ProbeResultFail evidence plus its Err; the caller must refuse to record
// readiness when any probe failed.
func (c *Client) RunReadinessProbes(ctx context.Context, releaseVersion, runID string) []ProbeOutcome {
	outcomes := make([]ProbeOutcome, 0, 4)
	aliases, err := c.aliasCatalog(ctx)
	outcomes = append(outcomes, probeOutcome("cliproxy", releaseVersion, runID, err))
	if err != nil {
		for _, engine := range []string{"codex", "kimi", "harness"} {
			outcomes = append(outcomes, probeOutcome(engine, releaseVersion, runID,
				errors.New("CLIProxyAPI management probe failed, skipping model turn")))
		}
		return outcomes
	}
	chatgptKey, err := c.provisionProbeKey(ctx, aliases, runID, "chatgpt", "Release readiness probe / ChatGPT-Codex", c.config.CodexModels)
	if err == nil {
		defer c.revokeProbeKey(context.WithoutCancel(ctx), probeKeyID(runID, "chatgpt"))
	}
	kimiKey, kimiErr := c.provisionProbeKey(ctx, aliases, runID, "kimi", "Release readiness probe / Kimi", c.config.KimiModels)
	if kimiErr == nil {
		defer c.revokeProbeKey(context.WithoutCancel(ctx), probeKeyID(runID, "kimi"))
	}
	if err == nil {
		err = c.chatTurn(ctx, chatgptKey, c.config.CodexModel, "codex")
	}
	outcomes = append(outcomes, probeOutcome("codex", releaseVersion, runID, err))
	if kimiErr == nil {
		kimiErr = c.chatTurn(ctx, kimiKey, c.config.KimiModel, "kimi")
	}
	outcomes = append(outcomes, probeOutcome("kimi", releaseVersion, runID, kimiErr))
	harnessErr := err
	if harnessErr == nil {
		// The Harness provider shares the ChatGPT-side key and model; its
		// readiness is the same real gateway round trip labelled "harness".
		harnessErr = c.chatTurn(ctx, chatgptKey, c.config.CodexModel, "harness")
	}
	outcomes = append(outcomes, probeOutcome("harness", releaseVersion, runID, harnessErr))
	return outcomes
}

func probeOutcome(engine, releaseVersion, runID string, err error) ProbeOutcome {
	result := contracts.ProbeResultPass
	if err != nil {
		result = contracts.ProbeResultFail
	}
	return ProbeOutcome{
		Evidence: contracts.ProbeEvidence{
			Engine: engine, Version: releaseVersion, RunID: runID,
			CheckedAt: time.Now().UTC(), Result: result, Redacted: true,
		},
		Err: err,
	}
}

func probeKeyID(runID, side string) string {
	digest := sha256.Sum256([]byte("release-readiness-probe:" + runID))
	return "aionui-probe-" + hex.EncodeToString(digest[:8]) + "-" + side
}

// provisionProbeKey creates one temporary downstream key through the same
// cpa-key-policy management route used for employee keys, scoped to the given
// aliases. The one-time plain key is returned for the probe turn and must be
// revoked by the caller.
func (c *Client) provisionProbeKey(ctx context.Context, aliases map[string][]keyModel, runID, side, name string, aliasNames []string) (string, error) {
	key := keyWrite{
		ID: probeKeyID(runID, side), Name: name, Enabled: true, RPM: c.config.RPM,
		DailyLimitUSD: c.config.CodexDailyUSD, WeeklyLimitUSD: c.config.CodexWeeklyUSD,
	}
	if side == "kimi" {
		key.DailyLimitUSD, key.WeeklyLimitUSD = c.config.KimiDailyUSD, c.config.KimiWeeklyUSD
	}
	for _, alias := range aliasNames {
		models := aliases[strings.ToLower(alias)]
		if len(models) == 0 {
			return "", fmt.Errorf("CLIProxyAPI alias is unavailable: %s", alias)
		}
		key.Models = append(key.Models, models...)
	}
	var result struct {
		PlainKey string `json:"plain_key"`
	}
	if err := c.json(ctx, http.MethodPost, "/keys", key, &result); err != nil {
		return "", fmt.Errorf("provision %s probe key: %w", side, err)
	}
	if !plainKeyPattern.MatchString(result.PlainKey) {
		return "", errors.New("CLIProxyAPI did not return a valid one-time probe key")
	}
	return result.PlainKey, nil
}

// revokeProbeKey removes a temporary probe key, preferring deletion and
// falling back to disabling when the deployed plugin exposes no deletion.
// Revocation is best-effort: the probe result stands on the completed turn.
func (c *Client) revokeProbeKey(ctx context.Context, id string) {
	operation := c.json(ctx, http.MethodDelete, "/keys", map[string]string{"id": id}, nil)
	var status *statusError
	if errors.As(operation, &status) && (status.status == http.StatusNotFound || status.status == http.StatusMethodNotAllowed) {
		_ = c.json(ctx, http.MethodPatch, "/keys", keyWrite{ID: id, Name: "Release readiness probe (revoked)", Enabled: false}, nil)
	}
}

// chatTurn performs one real OpenAI-compatible model round trip through the
// managed gateway and requires the exact sentinel answer, the same check the
// native CLI smoke applies.
func (c *Client) chatTurn(ctx context.Context, plainKey, model, engine string) error {
	marker := "WORKAGENT3_" + strings.ToUpper(engine) + "_CLIPROXY_OK"
	payload, err := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]string{{
			"role":    "user",
			"content": "Reply with exactly " + marker + ". Do not call tools or modify files.",
		}},
		// 512 leaves headroom for reasoning models (kimi k3 spends reasoning
		// tokens before the answer; 32 was fully consumed by them).
		"max_tokens": 512,
		"stream":     false,
	})
	if err != nil {
		return errors.New("encode readiness probe request")
	}
	turnCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(turnCtx, http.MethodPost, strings.TrimRight(c.config.BaseURL, "/")+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return errors.New("create readiness probe request")
	}
	request.Header.Set("Authorization", "Bearer "+plainKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := probeTurnClient.Do(request)
	if err != nil {
		return fmt.Errorf("readiness probe turn for %s failed to reach the model gateway", engine)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (1024*1024)+1))
	if err != nil || len(body) > 1024*1024 {
		return errors.New("readiness probe response is unreadable or oversized")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("readiness probe turn for %s returned HTTP %d", engine, response.StatusCode)
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(body, &completion) != nil || len(completion.Choices) == 0 {
		return fmt.Errorf("readiness probe turn for %s returned an invalid completion", engine)
	}
	if !strings.Contains(completion.Choices[0].Message.Content, marker) {
		return fmt.Errorf("readiness probe turn for %s did not return the sentinel answer", engine)
	}
	return nil
}
