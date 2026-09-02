package modelgateway

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKeyPrefixMatchesManagedSIDConvention(t *testing.T) {
	if actual := keyPrefix("S-1-5-21-100-200-300-1017"); actual != "aionui-c6caa7a66c7a1ad24ed9" {
		t.Fatalf("key prefix = %q", actual)
	}
}

func completeConfig(t *testing.T) Config {
	t.Helper()
	keyFile := filepath.Join(t.TempDir(), "management.key")
	if err := os.WriteFile(keyFile, []byte("0123456789abcdef0123456789abcdef01234567\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	restrictTestKeyFileACL(t, keyFile)
	return Config{
		ManagementURL:     "http://127.0.0.1:8317/v0/management/plugins/cpa-key-policy",
		ManagementKeyFile: keyFile,
		BaseURL:           "http://127.0.0.1:8317/v1",
		CodexModel:        "gpt-5.6-sol",
		CodexModels:       []string{"gpt-5.6-luna", "gpt-5.6-sol"},
		KimiModel:         "kimi-k3",
		KimiModels:        []string{"kimi-for-coding", "kimi-k3"},
		RPM:               30,
		CodexDailyUSD:     40,
		CodexWeeklyUSD:    80,
		KimiDailyUSD:      10,
		KimiWeeklyUSD:     20,
	}
}

func TestNewCLIProxyRequiresExplicitModelsAndQuotas(t *testing.T) {
	config := completeConfig(t)
	config.CodexModel, config.CodexModels, config.KimiModel, config.KimiModels = "", nil, "", nil
	config.RPM, config.CodexDailyUSD, config.CodexWeeklyUSD, config.KimiDailyUSD, config.KimiWeeklyUSD = 0, 0, 0, 0, 0
	_, err := NewCLIProxy(config)
	if err == nil {
		t.Fatal("missing model and quota configuration was silently defaulted")
	}
	for _, key := range []string{"codexModel", "codexModels", "kimiModel", "kimiModels", "rpm", "codexDailyUsd", "codexWeeklyUsd", "kimiDailyUsd", "kimiWeeklyUsd"} {
		if !strings.Contains(err.Error(), key) {
			t.Fatalf("error %q does not name missing key %s", err, key)
		}
	}
	if !strings.Contains(err.Error(), "docs/employee-manager.config.example.json") {
		t.Fatalf("error %q does not point at the configuration template", err)
	}
}

func TestNewCLIProxyAcceptsCompleteConfiguration(t *testing.T) {
	if _, err := NewCLIProxy(completeConfig(t)); err != nil {
		t.Fatal(err)
	}
}
