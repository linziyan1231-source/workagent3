package architecture_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseProfileContainsRunnableDSHAndBuildPolicy(t *testing.T) {
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	manifestPayload, err := os.ReadFile(filepath.Join(repositoryRoot, "profiles", "workagent", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(manifestPayload, &manifest); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(manifest.Dependencies["@deepseek-ai/dsh"]) == "" {
		t.Fatal("release Profile omits the DSH executable dependency")
	}

	workspacePayload, err := os.ReadFile(filepath.Join(repositoryRoot, "profiles", "workagent", "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	workspace := string(workspacePayload)
	for _, dependency := range []string{"@deepseek-ai/dsh-subprocess-local", "node-pty", "koffi"} {
		if !strings.Contains(workspace, dependency) {
			t.Fatalf("release Profile build policy omits %s", dependency)
		}
	}

	dumpPayload, err := os.ReadFile(filepath.Join(repositoryRoot, "scripts", "dump-harness-profile.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	dumpScript := string(dumpPayload)
	if !strings.Contains(dumpScript, "pnpm-workspace.yaml") {
		t.Fatal("Profile dump does not project the pnpm build policy")
	}
	if strings.Contains(dumpScript, "--ignore-workspace") {
		t.Fatal("Profile dump bypasses its pnpm build policy")
	}
}
