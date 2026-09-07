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
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/contracts"
	"workagent3/internal/nativeauth"
)

var (
	managementKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{40,256}$`)
	plainKeyPattern      = regexp.MustCompile(`^cpa_[A-Za-z0-9_-]{20,256}$`)
)

type Config struct {
	ManagementURL     string   `json:"managementUrl"`
	ManagementKeyFile string   `json:"managementKeyFile"`
	BaseURL           string   `json:"baseUrl"`
	CodexModel        string   `json:"codexModel"`
	CodexModels       []string `json:"codexModels"`
	KimiModel         string   `json:"kimiModel"`
	KimiModels        []string `json:"kimiModels"`
	RPM               int      `json:"rpm"`
	CodexDailyUSD     float64  `json:"codexDailyUsd"`
	CodexWeeklyUSD    float64  `json:"codexWeeklyUsd"`
	KimiDailyUSD      float64  `json:"kimiDailyUsd"`
	KimiWeeklyUSD     float64  `json:"kimiWeeklyUsd"`
}

type Client struct {
	config     Config
	base       string
	key        string
	http       *http.Client
	audit      audit.Sink
	actor      string
	keyIndexer KeyIndexer
}

// KeyIndexer persists the opaque key ID → SID mapping for issued downstream
// keys. quota.Store implements it. Gateway usage records identify callers by
// managed key ID, so the usage drain needs this mapping to attribute them; no
// key material is involved on either side.
type KeyIndexer interface {
	IndexGatewayKeys(ctx context.Context, sid string, keyIDs []string) error
}

// SetKeyIndexer wires the gateway key index updated on every successful
// Provision. A nil indexer disables indexing.
func (c *Client) SetKeyIndexer(indexer KeyIndexer) {
	c.keyIndexer = indexer
}

// SetAudit wires the business audit sink for downstream key lifecycle events.
// The actor identifies the calling subsystem (for example
// "employee-manager"). Plain key material is never recorded: event targets
// are the opaque managed key IDs. A nil sink disables business auditing.
func (c *Client) SetAudit(sink audit.Sink, actor string) {
	c.audit, c.actor = sink, strings.TrimSpace(actor)
}

type keyModel struct {
	Alias                    string  `json:"alias"`
	Provider                 string  `json:"provider"`
	TargetModel              string  `json:"target_model"`
	Group                    string  `json:"group,omitempty"`
	BillingMode              string  `json:"billing_mode,omitempty"`
	InputPricePerMillion     float64 `json:"input_price_per_million,omitempty"`
	OutputPricePerMillion    float64 `json:"output_price_per_million,omitempty"`
	CacheReadPricePerMillion float64 `json:"cache_read_price_per_million,omitempty"`
	PerCallUSD               float64 `json:"per_call_usd,omitempty"`
}

type keyWrite struct {
	ID                  string     `json:"id"`
	Name                string     `json:"name"`
	Enabled             bool       `json:"enabled"`
	RPM                 int        `json:"rpm"`
	Models              []keyModel `json:"models"`
	DailyLimitUSD       float64    `json:"daily_limit_usd"`
	WeeklyLimitUSD      float64    `json:"weekly_limit_usd"`
	AllowModelsEndpoint bool       `json:"allow_models_endpoint"`
}

func NewCLIProxy(config Config) (*Client, error) {
	// Model and quota values are deployment decisions: they must come from the
	// employee-manager configuration file (see
	// docs/employee-manager.config.example.json), never from code defaults.
	var missing []string
	if len(config.CodexModels) == 0 {
		missing = append(missing, "codexModels")
	}
	if len(config.KimiModels) == 0 {
		missing = append(missing, "kimiModels")
	}
	if config.CodexModel == "" {
		missing = append(missing, "codexModel")
	}
	if config.KimiModel == "" {
		missing = append(missing, "kimiModel")
	}
	if config.RPM == 0 {
		missing = append(missing, "rpm")
	}
	if config.CodexDailyUSD == 0 {
		missing = append(missing, "codexDailyUsd")
	}
	if config.CodexWeeklyUSD == 0 {
		missing = append(missing, "codexWeeklyUsd")
	}
	if config.KimiDailyUSD == 0 {
		missing = append(missing, "kimiDailyUsd")
	}
	if config.KimiWeeklyUSD == 0 {
		missing = append(missing, "kimiWeeklyUsd")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("CLIProxyAPI model gateway configuration is missing required keys: %s (see docs/employee-manager.config.example.json)", strings.Join(missing, ", "))
	}
	endpoint, err := url.Parse(config.ManagementURL)
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.Port() == "" || endpoint.Path != "/v0/management/plugins/cpa-key-policy" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("CLIProxyAPI management URL must be the exact loopback policy endpoint")
	}
	if !filepath.IsAbs(config.ManagementKeyFile) {
		return nil, errors.New("CLIProxyAPI management key file must be absolute")
	}
	info, err := os.Lstat(config.ManagementKeyFile)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 1024 {
		return nil, errors.New("CLIProxyAPI management key file must be a bounded regular non-symlink file")
	}
	if err := verifyManagementKeyFileACL(config.ManagementKeyFile); err != nil {
		return nil, err
	}
	payload, err := os.ReadFile(config.ManagementKeyFile)
	if err != nil {
		return nil, errors.New("read CLIProxyAPI management key")
	}
	key := strings.TrimSpace(string(payload))
	clear(payload)
	if !managementKeyPattern.MatchString(key) {
		return nil, errors.New("CLIProxyAPI management key is invalid")
	}
	probe := nativeauth.Bundle{FormatVersion: 1, BaseURL: config.BaseURL, CodexAPIKey: "cpa_abcdefghijklmnopqrstuvwxyz", KimiAPIKey: "cpa_zyxwvutsrqponmlkjihgfedcba", CodexModel: config.CodexModel, KimiModel: config.KimiModel}
	if err := probe.Validate(); err != nil {
		return nil, err
	}
	if config.CodexWeeklyUSD != config.CodexDailyUSD*2 || config.KimiWeeklyUSD != config.KimiDailyUSD*2 || config.RPM < 1 || config.RPM > 100000 {
		return nil, errors.New("CLIProxyAPI quota policy is invalid")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &Client{config: config, base: strings.TrimRight(config.ManagementURL, "/"), key: key, http: &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) Provision(ctx context.Context, username, sid string) (nativeauth.Bundle, error) {
	if strings.TrimSpace(username) == "" || !strings.HasPrefix(sid, "S-1-") {
		return nativeauth.Bundle{}, errors.New("employee identity is invalid for native model provisioning")
	}
	aliases, err := c.aliasCatalog(ctx)
	if err != nil {
		return nativeauth.Bundle{}, err
	}
	existing, err := c.listKeys(ctx)
	if err != nil {
		return nativeauth.Bundle{}, err
	}
	correlationID, correlationErr := auth.RandomToken(18)
	if correlationErr != nil {
		correlationID = ""
	}
	prefix := keyPrefix(sid)
	desired := []struct {
		key     keyWrite
		aliases []string
	}{
		{key: keyWrite{ID: prefix + "-chatgpt", Name: username + " / ChatGPT-Codex", Enabled: true, RPM: c.config.RPM, DailyLimitUSD: c.config.CodexDailyUSD, WeeklyLimitUSD: c.config.CodexWeeklyUSD, AllowModelsEndpoint: true}, aliases: c.config.CodexModels},
		{key: keyWrite{ID: prefix + "-kimi", Name: username + " / Kimi", Enabled: true, RPM: c.config.RPM, DailyLimitUSD: c.config.KimiDailyUSD, WeeklyLimitUSD: c.config.KimiWeeklyUSD, AllowModelsEndpoint: true}, aliases: c.config.KimiModels},
	}
	plain := make(map[string]string, 2)
	for index := range desired {
		for _, alias := range desired[index].aliases {
			models := aliases[strings.ToLower(alias)]
			if len(models) == 0 {
				return nativeauth.Bundle{}, fmt.Errorf("CLIProxyAPI alias is unavailable: %s", alias)
			}
			desired[index].key.Models = append(desired[index].key.Models, models...)
		}
		var result struct {
			PlainKey string `json:"plain_key"`
		}
		var operation error
		action := audit.ActionModelGatewayKeyProvision
		if _, found := existing[desired[index].key.ID]; found {
			action = audit.ActionModelGatewayKeyRotate
			if operation = c.json(ctx, http.MethodPatch, "/keys", desired[index].key, &struct {
				Key json.RawMessage `json:"key"`
			}{}); operation == nil {
				operation = c.json(ctx, http.MethodPost, "/keys/rotate", map[string]string{"id": desired[index].key.ID}, &result)
			}
		} else {
			operation = c.json(ctx, http.MethodPost, "/keys", desired[index].key, &result)
		}
		c.recordKeyEvent(ctx, correlationID, action, desired[index].key.ID, operation)
		if operation != nil {
			return nativeauth.Bundle{}, operation
		}
		if !plainKeyPattern.MatchString(result.PlainKey) {
			return nativeauth.Bundle{}, errors.New("CLIProxyAPI did not return a valid one-time key")
		}
		plain[desired[index].key.ID] = result.PlainKey
	}
	bundle := nativeauth.Bundle{FormatVersion: 1, BaseURL: c.config.BaseURL, CodexAPIKey: plain[prefix+"-chatgpt"], KimiAPIKey: plain[prefix+"-kimi"], CodexModel: c.config.CodexModel, KimiModel: c.config.KimiModel, KimiModels: c.config.KimiModels}
	if err := bundle.Validate(); err != nil {
		return nativeauth.Bundle{}, err
	}
	// The new keys are live at the gateway now; their IDs must reach the usage
	// key index before the bundle is handed out, or the drain cannot attribute
	// the usage they generate. Key IDs survive in-place rotation, so indexing
	// here also covers rotated keys. Indexing failure fails the provision.
	if c.keyIndexer != nil {
		if err := c.keyIndexer.IndexGatewayKeys(ctx, sid, managedKeyIDs(sid)); err != nil {
			return nativeauth.Bundle{}, fmt.Errorf("index CLIProxyAPI downstream keys: %w", err)
		}
	}
	return bundle, nil
}

// SetKeysEnabled flips the enabled flag on both SID downstream keys
// (<prefix>-chatgpt and <prefix>-kimi). The current record is read back and
// re-sent with only Enabled changed, so the call is safe whether the
// cpa-key-policy plugin treats PATCH as a partial or a full update. Keys
// absent from the listing are already out of service and are skipped, which
// makes the operation idempotent under replay.
func (c *Client) SetKeysEnabled(ctx context.Context, sid string, enabled bool) error {
	if !strings.HasPrefix(sid, "S-1-") {
		return errors.New("employee SID is invalid for model gateway key management")
	}
	existing, err := c.listKeys(ctx)
	if err != nil {
		return err
	}
	action := audit.ActionModelGatewayKeyDisable
	if enabled {
		action = audit.ActionModelGatewayKeyEnable
	}
	correlationID, correlationErr := auth.RandomToken(18)
	if correlationErr != nil {
		correlationID = ""
	}
	for _, id := range managedKeyIDs(sid) {
		record, found := existing[id]
		if !found || record.Enabled == enabled {
			continue
		}
		record.Enabled = enabled
		operation := c.json(ctx, http.MethodPatch, "/keys", record, nil)
		c.recordKeyEvent(ctx, correlationID, action, id, operation)
		if operation != nil {
			return operation
		}
	}
	return nil
}

// RevokeKeys permanently removes both SID downstream keys. The plugin has no
// dedicated revocation concept: deletion via DELETE /keys is preferred, and
// where the deployed plugin does not expose deletion (HTTP 404/405) the
// closest available semantics — permanently disabling the key — is applied
// instead. Keys already absent are skipped, so the operation is idempotent.
func (c *Client) RevokeKeys(ctx context.Context, sid string) error {
	if !strings.HasPrefix(sid, "S-1-") {
		return errors.New("employee SID is invalid for model gateway key management")
	}
	existing, err := c.listKeys(ctx)
	if err != nil {
		return err
	}
	correlationID, correlationErr := auth.RandomToken(18)
	if correlationErr != nil {
		correlationID = ""
	}
	for _, id := range managedKeyIDs(sid) {
		record, found := existing[id]
		if !found {
			continue
		}
		operation := c.json(ctx, http.MethodDelete, "/keys", map[string]string{"id": id}, nil)
		var status *statusError
		if errors.As(operation, &status) && (status.status == http.StatusNotFound || status.status == http.StatusMethodNotAllowed) {
			record.Enabled = false
			operation = c.json(ctx, http.MethodPatch, "/keys", record, nil)
		}
		c.recordKeyEvent(ctx, correlationID, audit.ActionModelGatewayKeyRevoke, id, operation)
		if operation != nil {
			return operation
		}
	}
	return nil
}

func (c *Client) listKeys(ctx context.Context) (map[string]keyWrite, error) {
	var listed struct {
		Keys []keyWrite `json:"keys"`
	}
	if err := c.json(ctx, http.MethodGet, "/keys", nil, &listed); err != nil {
		return nil, err
	}
	result := make(map[string]keyWrite, len(listed.Keys))
	for _, key := range listed.Keys {
		result[key.ID] = key
	}
	return result, nil
}

// recordKeyEvent writes one business audit event per managed key. Recording
// never fails the key operation itself, matching the Portal middleware
// policy; plain key material is never part of the event.
func (c *Client) recordKeyEvent(ctx context.Context, correlationID, action, keyID string, operation error) {
	if c.audit == nil || correlationID == "" {
		return
	}
	result := "success"
	if operation != nil {
		result = "failure"
	}
	_, _ = c.audit.Record(context.WithoutCancel(ctx), contracts.AuditInput{
		Actor: c.actor, Target: keyID, Action: action, Result: result, CorrelationID: correlationID,
	})
}

func managedKeyIDs(sid string) []string {
	prefix := keyPrefix(sid)
	return []string{prefix + "-chatgpt", prefix + "-kimi"}
}

func (c *Client) aliasCatalog(ctx context.Context) (map[string][]keyModel, error) {
	var listed struct {
		Aliases []json.RawMessage `json:"aliases"`
	}
	if err := c.json(ctx, http.MethodGet, "/aliases", nil, &listed); err != nil {
		return nil, err
	}
	result := make(map[string][]keyModel, len(listed.Aliases))
	for _, raw := range listed.Aliases {
		var alias struct {
			Alias                    string  `json:"alias"`
			BillingMode              string  `json:"billing_mode,omitempty"`
			InputPricePerMillion     float64 `json:"input_price_per_million,omitempty"`
			OutputPricePerMillion    float64 `json:"output_price_per_million,omitempty"`
			CacheReadPricePerMillion float64 `json:"cache_read_price_per_million,omitempty"`
			PerCallUSD               float64 `json:"per_call_usd,omitempty"`
			Targets                  []struct {
				Provider    string `json:"provider"`
				TargetModel string `json:"target_model"`
				Group       string `json:"group,omitempty"`
			} `json:"targets"`
		}
		if json.Unmarshal(raw, &alias) != nil || strings.TrimSpace(alias.Alias) == "" {
			return nil, errors.New("CLIProxyAPI alias catalog is invalid")
		}
		key := strings.ToLower(alias.Alias)
		if _, duplicate := result[key]; duplicate {
			return nil, errors.New("CLIProxyAPI alias catalog contains duplicates")
		}
		for _, target := range alias.Targets {
			result[key] = append(result[key], keyModel{Alias: alias.Alias, Provider: target.Provider, TargetModel: target.TargetModel, Group: target.Group, BillingMode: alias.BillingMode, InputPricePerMillion: alias.InputPricePerMillion, OutputPricePerMillion: alias.OutputPricePerMillion, CacheReadPricePerMillion: alias.CacheReadPricePerMillion, PerCallUSD: alias.PerCallUSD})
		}
	}
	return result, nil
}

type statusError struct{ status int }

func (e *statusError) Error() string {
	return fmt.Sprintf("CLIProxyAPI management returned HTTP %d", e.status)
}

func (c *Client) json(ctx context.Context, method, route string, input, output any) error {
	return c.jsonURL(ctx, method, c.base+route, input, output)
}

func (c *Client) jsonURL(ctx context.Context, method, fullURL string, input, output any) error {
	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
			return errors.New("encode CLIProxyAPI request")
		}
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		return errors.New("create CLIProxyAPI request")
	}
	request.Header.Set("Authorization", "Bearer "+c.key)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return errors.New("CLIProxyAPI management connection failed")
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, (2*1024*1024)+1))
	if err != nil || len(payload) > 2*1024*1024 {
		return errors.New("CLIProxyAPI management response is unreadable or oversized")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &statusError{status: response.StatusCode}
	}
	if output == nil {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if decoder.Decode(output) != nil {
		return errors.New("CLIProxyAPI management returned invalid JSON")
	}
	return nil
}

func keyPrefix(sid string) string {
	digest := sha256.Sum256([]byte(strings.ToUpper(sid)))
	return "aionui-" + hex.EncodeToString(digest[:10])
}
