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
	t.Setenv("WORKAGENT_TEST_ALLOWED", "must-not-leak")
	directories := privateDirectories{dshHome: `C:\data\dsh`, workspace: `C:\data\workspace`, native: `C:\data\native`}
	environment := runtimeEnvironment(directories, "runtime-token", 43123, "S-1-5-21-1000", "http://127.0.0.1:8080", "platform-token", `C:\agents\codex.exe`, `C:\agents\kimi.exe`, `C:\release\managed-tools\officecli`)
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
