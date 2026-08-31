//go:build windows

package employee

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/userhost"
	"workagent3/internal/winutil"
)

func TestWriteAtomicReplacesProvisionedRuntimeFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.token")
	if err := writeAtomic(path, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(path, []byte("second")); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(path)
	if err != nil || string(payload) != "second" {
		t.Fatalf("replacement payload=%q err=%v", payload, err)
	}
}

func TestUpdateInstalledLimitsPreservesSIDOwnedRuntimeConfig(t *testing.T) {
	root := t.TempDir()
	sid := "S-1-5-21-1000"
	runtimeDirectory := filepath.Join(root, sid, "runtime")
	if err := os.MkdirAll(runtimeDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(runtimeDirectory, "userhost.json")
	payload, _ := json.Marshal(userhost.FileConfig{SID: sid, DataRoot: filepath.Join(root, sid), HarnessCommand: `C:\\dsh.exe`, HarnessArguments: []string{"index.js"}, Profile: "workagent", PortalURL: "http://127.0.0.1:8080", RegistrationCredentialFile: filepath.Join(runtimeDirectory, "token"), Limits: winutil.JobLimits{MemoryBytes: 1024 * 1024 * 1024, CPUPercent: 25, ActiveProcesses: 16}})
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	platform := &WindowsPlatform{config: WindowsPlatformConfig{DataRootBase: root}}
	limits := winutil.JobLimits{MemoryBytes: 2 * 1024 * 1024 * 1024, CPUPercent: 50, ActiveProcesses: 32}
	if err := platform.UpdateInstalledLimits(context.Background(), sid, limits); err != nil {
		t.Fatal(err)
	}
	updatedPayload, _ := os.ReadFile(path)
	var updated userhost.FileConfig
	if err := json.Unmarshal(updatedPayload, &updated); err != nil || updated.SID != sid || updated.Limits != limits {
		t.Fatalf("runtime config was not atomically updated: %+v %v", updated, err)
	}
}

func TestTaskPowerShellEnvironmentDoesNotInheritServiceSecrets(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "must-not-leak")
	environment := strings.Join(restrictedEnvironment(map[string]string{"WA3_TASK": "WorkAgent3-test"}), "\n")
	if strings.Contains(environment, "must-not-leak") {
		t.Fatal("service credential leaked into Task Scheduler helper")
	}
	if !strings.Contains(environment, "WA3_TASK=WorkAgent3-test") {
		t.Fatal("task input missing")
	}
}
