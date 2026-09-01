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
	config Config
	base   string
	key    string
	http   *http.Client
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
	if len(config.CodexModels) == 0 {
		config.CodexModels = []string{"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"}
	}
	if len(config.KimiModels) == 0 {
		config.KimiModels = []string{"kimi-for-coding", "kimi-for-coding-highspeed", "kimi-k3"}
	}
	if config.CodexModel == "" {
		config.CodexModel = "gpt-5.6-sol"
	}
	if config.KimiModel == "" {
		config.KimiModel = "kimi-k3"
	}
	if config.RPM == 0 {
		config.RPM = 30
	}
	if config.CodexDailyUSD == 0 {
		config.CodexDailyUSD, config.CodexWeeklyUSD = 40, 80
	}
	if config.KimiDailyUSD == 0 {
		config.KimiDailyUSD, config.KimiWeeklyUSD = 10, 20
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
	var listed struct {
		Keys []struct {
			ID string `json:"id"`
		} `json:"keys"`
	}
	if err := c.json(ctx, http.MethodGet, "/keys", nil, &listed); err != nil {
		return nativeauth.Bundle{}, err
	}
	existing := make(map[string]bool, len(listed.Keys))
	for _, key := range listed.Keys {
		existing[key.ID] = true
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
		if existing[desired[index].key.ID] {
			if err := c.json(ctx, http.MethodPatch, "/keys", desired[index].key, &struct {
				Key json.RawMessage `json:"key"`
			}{}); err != nil {
				return nativeauth.Bundle{}, err
			}
			if err := c.json(ctx, http.MethodPost, "/keys/rotate", map[string]string{"id": desired[index].key.ID}, &result); err != nil {
				return nativeauth.Bundle{}, err
			}
		} else if err := c.json(ctx, http.MethodPost, "/keys", desired[index].key, &result); err != nil {
			return nativeauth.Bundle{}, err
		}
		if !plainKeyPattern.MatchString(result.PlainKey) {
			return nativeauth.Bundle{}, errors.New("CLIProxyAPI did not return a valid one-time key")
		}
		plain[desired[index].key.ID] = result.PlainKey
	}
	bundle := nativeauth.Bundle{FormatVersion: 1, BaseURL: c.config.BaseURL, CodexAPIKey: plain[prefix+"-chatgpt"], KimiAPIKey: plain[prefix+"-kimi"], CodexModel: c.config.CodexModel, KimiModel: c.config.KimiModel}
	if err := bundle.Validate(); err != nil {
		return nativeauth.Bundle{}, err
	}
	return bundle, nil
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

func (c *Client) json(ctx context.Context, method, route string, input, output any) error {
	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
			return errors.New("encode CLIProxyAPI request")
		}
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.base+route, body)
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
		return fmt.Errorf("CLIProxyAPI management returned HTTP %d", response.StatusCode)
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
