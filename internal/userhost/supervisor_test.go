package userhost

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/winutil"
)

func TestRuntimeEnvironmentDoesNotInheritServiceSecrets(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "must-not-leak")
	t.Setenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
	t.Setenv("WORKAGENT_TEST_ALLOWED", "must-not-leak")
	directories := privateDirectories{dshHome: `C:\data\dsh`, workspace: `C:\data\workspace`, native: `C:\data\native`}
	environment := runtimeEnvironment(directories, "runtime-token", 43123, "S-1-5-21-1000", "http://127.0.0.1:8080", "platform-token", `C:\agents\codex.exe`, `C:\agents\kimi.exe`, `C:\release\managed-tools\officecli`, "http://127.0.0.1:8317/v1", "gpt-5.6-sol", map[string]string{"DSH_BOOKING_SKILL_MODE": "demo"})
	joined := strings.Join(environment, "\n")
	if strings.Contains(joined, "must-not-leak") {
		t.Fatal("unrelated service credential inherited")
	}
	if !strings.Contains(joined, "WORKAGENT_RUNTIME_TOKEN=runtime-token") {
		t.Fatal("runtime token missing")
	}
	if !strings.Contains(joined, "WORKAGENT_EMPLOYEE_SID=S-1-5-21-1000") || !strings.Contains(joined, "WORKAGENT_PLATFORM_URL=http://127.0.0.1:8080") || !strings.Contains(joined, "WORKAGENT_PLATFORM_TOKEN=platform-token") {
		t.Fatal("scoped Platform quota capability missing")
	}
	if !strings.Contains(joined, `WORKAGENT_WORKSPACE_ROOT=C:\data\workspace`) {
		t.Fatal("workspace root missing")
	}
	if !strings.Contains(joined, `WORKAGENT_CODEX_BIN=C:\agents\codex.exe`) || !strings.Contains(joined, `WORKAGENT_KIMI_BIN=C:\agents\kimi.exe`) {
		t.Fatalf("native engine paths missing from runtime environment: %v", environment)
	}
	if strings.Contains(joined, "KIMI_HOME=") || !strings.Contains(joined, "KIMI_CODE_HOME=") {
		t.Fatalf("Kimi private home is not configured correctly: %v", environment)
	}
	if !strings.Contains(joined, `PATH=C:\release\managed-tools\officecli`) {
		t.Fatal("managed tools were not prepended to the Harness PATH")
	}
	// The managed provider endpoint must come from configuration only, never
	// from the inherited environment.
	if strings.Contains(joined, "https://api.deepseek.com") {
		t.Fatal("inherited public DeepSeek endpoint leaked into the Harness environment")
	}
	if !strings.Contains(joined, "DEEPSEEK_BASE_URL=http://127.0.0.1:8317/v1") || !strings.Contains(joined, "WORKAGENT_HARNESS_MODEL=gpt-5.6-sol") {
		t.Fatalf("managed Harness model route missing from runtime environment: %v", environment)
	}
}

func TestRuntimeEnvironmentOmitsManagedModelRouteWithoutGateway(t *testing.T) {
	directories := privateDirectories{dshHome: `C:\data\dsh`, workspace: `C:\data\workspace`, native: `C:\data\native`}
	environment := runtimeEnvironment(directories, "runtime-token", 43123, "S-1-5-21-1000", "http://127.0.0.1:8080", "platform-token", "", "", "", "", "", nil)
	joined := strings.Join(environment, "\n")
	if strings.Contains(joined, "DEEPSEEK_BASE_URL=") || strings.Contains(joined, "WORKAGENT_HARNESS_MODEL=") {
		t.Fatalf("unmanaged deployment gained a managed model route: %v", environment)
	}
}

func TestHarnessEnvironmentAppendsAndReservesSupervisorKeys(t *testing.T) {
	directories := privateDirectories{dshHome: `C:\data\dsh`, workspace: `C:\data\workspace`, native: `C:\data\native`}
	environment := runtimeEnvironment(directories, "runtime-token", 43123, "S-1-5-21-1000", "http://127.0.0.1:8080", "platform-token", "", "", "", "", "", map[string]string{
		"DSH_BOOKING_SKILL_MODE": "demo",
		"DSH_BOOKING_TENANT_ID":  "tenant-a",
	})
	joined := strings.Join(environment, "\n")
	if !strings.Contains(joined, "DSH_BOOKING_SKILL_MODE=demo") || !strings.Contains(joined, "DSH_BOOKING_TENANT_ID=tenant-a") {
		t.Fatalf("deployment-supplied Harness environment missing: %v", environment)
	}
	cases := []map[string]string{
		{"DSH-BOOKING": "x"},
		{"PATH": `C:\evil`},
		{"dsh_home": `C:\evil`},
		{"WORKAGENT_RUNTIME_TOKEN": "forged"},
		{"DSH_BOOKING_TENANT_ID": "a\nb"},
	}
	for _, invalid := range cases {
		if err := ValidateHarnessEnvironment(invalid); err == nil {
			t.Fatalf("accepted invalid Harness environment: %v", invalid)
		}
	}
	if err := ValidateHarnessEnvironment(map[string]string{"DSH_BOOKING_SKILL_MODE": "demo"}); err != nil {
		t.Fatal(err)
	}
}

func TestConfigRequiresPairedHarnessModelAndGateway(t *testing.T) {
	root := t.TempDir()
	base := Config{SID: "S-1-5-21-1000", DataRoot: root, Command: "dsh", Profile: "workagent", PlatformURL: "http://127.0.0.1:8080", PlatformCredential: "token", Limits: winutil.JobLimits{}}
	if _, err := New(base); err != nil {
		t.Fatal(err)
	}
	unpaired := base
	unpaired.HarnessModel = "gpt-5.6-sol"
	if _, err := New(unpaired); err == nil {
		t.Fatal("accepted a Harness model without the gateway base URL")
	}
	nonLoopback := base
	nonLoopback.HarnessModel, nonLoopback.ModelGatewayBaseURL = "gpt-5.6-sol", "https://api.deepseek.com/v1"
	if _, err := New(nonLoopback); err == nil {
		t.Fatal("accepted a non-loopback model gateway base URL")
	}
	managed := base
	managed.HarnessModel, managed.ModelGatewayBaseURL = "gpt-5.6-sol", "http://127.0.0.1:8317/v1"
	if _, err := New(managed); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureDirectoriesUsesDocumentedLayout(t *testing.T) {
	root := t.TempDir()
	directories, err := ensureDirectories(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{directories.dshHome, directories.workspace, directories.runtime, directories.logs, filepath.Join(directories.native, "codex"), filepath.Join(directories.native, "kimi")} {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("missing directory %s", path)
		}
	}
}

func TestConfigRejectsRelativeDataRoot(t *testing.T) {
	_, err := New(Config{SID: "S-1-5-21-1000", DataRoot: "relative", Command: "dsh", Profile: "workagent", Limits: winutil.JobLimits{}})
	if err == nil {
		t.Fatal("accepted relative data root")
	}
}
