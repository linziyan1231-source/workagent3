//go:build windows

package employee

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"workagent3/internal/mcpruntime"
	"workagent3/internal/store"
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

func TestRuntimeConfigProjectsManagedSkillsRelease(t *testing.T) {
	root := t.TempDir()
	managedSkillsRoot := filepath.Join(root, "release", "managed-skills")
	managedServer := mcpruntime.Server{
		ID: "managed", Name: "Managed", Source: "managed", Enabled: false,
		Transport: mcpruntime.Transport{
			Kind: "stdio", Command: filepath.Join(root, "managed.exe"),
			Args: []string{"--workspace", "${WORKSPACE_ROOT}", "--sid", "${SID}"},
		},
		ToolPolicy: "none", OAuthState: "none", Health: "unavailable",
	}
	platform := &WindowsPlatform{config: WindowsPlatformConfig{
		HarnessCommand:    filepath.Join(root, "dsh.exe"),
		HarnessEntrypoint: filepath.Join("dist", "index.js"),
		HarnessArguments:  []string{"--verbose"},
		Profile:           "workagent",
		PortalURL:         "http://127.0.0.1:8080",
		ManagedSkillsRoot: managedSkillsRoot,
		ManagedMCPServers: []mcpruntime.Server{managedServer},
	}}
	spec := RuntimeSpec{SID: "S-1-5-21-1000", DataRoot: filepath.Join(root, "employee")}
	config := platform.runtimeFileConfig(spec, filepath.Join(root, "registration.token"))
	if config.ManagedSkillsRoot != managedSkillsRoot {
		t.Fatalf("managed Skills release was not projected: %+v", config)
	}
	if len(config.ManagedMCPServers) != 1 || config.ManagedMCPServers[0].ID != managedServer.ID {
		t.Fatalf("managed MCP release was not projected: %+v", config)
	}
	expectedArguments := []string{"--workspace", filepath.Join(spec.DataRoot, "workspace"), "--sid", spec.SID}
	if !reflect.DeepEqual(config.ManagedMCPServers[0].Transport.Args, expectedArguments) {
		t.Fatalf("managed MCP SID variables were not expanded: %#v", config.ManagedMCPServers[0].Transport.Args)
	}
	if managedServer.Transport.Args[1] != "${WORKSPACE_ROOT}" {
		t.Fatal("shared managed MCP release definition was mutated")
	}
}

func TestRuntimeConfigProjectsManagedHarnessModelRoute(t *testing.T) {
	root := t.TempDir()
	platform := &WindowsPlatform{config: WindowsPlatformConfig{
		HarnessCommand:      filepath.Join(root, "dsh.exe"),
		HarnessEntrypoint:   filepath.Join("dist", "index.js"),
		Profile:             "workagent",
		PortalURL:           "http://127.0.0.1:8080",
		HarnessModel:        "gpt-5.6-sol",
		ModelGatewayBaseURL: "http://127.0.0.1:8317/v1",
	}}
	spec := RuntimeSpec{SID: "S-1-5-21-1000", DataRoot: filepath.Join(root, "employee")}
	config := platform.runtimeFileConfig(spec, filepath.Join(root, "registration.token"))
	if config.HarnessModel != "gpt-5.6-sol" || config.ModelGatewayBaseURL != "http://127.0.0.1:8317/v1" {
		t.Fatalf("managed Harness model route was not projected: %+v", config)
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

func TestLocalWindowsUsernameSeparatesPortalAndWindowsIdentity(t *testing.T) {
	if value := localWindowsUsername(store.User{Username: "portal.login", WindowsUsername: `WORKSTATION\windows.user`}); value != "windows.user" {
		t.Fatalf("local Windows username = %q", value)
	}
}

func TestRetainedEmployeeDataRootRejectsTraversalBeforeDeletion(t *testing.T) {
	base := t.TempDir()
	if _, err := retainedEmployeeDataRoot(base, `..\outside`); err == nil {
		t.Fatal("employee deletion accepted a traversal target")
	}
	target, err := retainedEmployeeDataRoot(base, "S-1-5-21-1000")
	if err != nil || filepath.Dir(target) != base {
		t.Fatalf("valid SID root was rejected: %q %v", target, err)
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
