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
	directories := privateDirectories{dshHome: `C:\data\dsh`, native: `C:\data\native`}
	environment := runtimeEnvironment(directories, "runtime-token", 43123)
	joined := strings.Join(environment, "\n")
	if strings.Contains(joined, "must-not-leak") {
		t.Fatal("unrelated service credential inherited")
	}
	if !strings.Contains(joined, "WORKAGENT_RUNTIME_TOKEN=runtime-token") {
		t.Fatal("runtime token missing")
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
