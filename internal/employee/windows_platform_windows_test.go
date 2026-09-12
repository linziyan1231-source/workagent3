//go:build windows

package employee

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

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
		HarnessCommand:         filepath.Join(root, "dsh.exe"),
		PublishedPythonCommand: filepath.Join(root, "release", "python.exe"),
		HarnessEntrypoint:      filepath.Join("dist", "index.js"),
		HarnessArguments:       []string{"--verbose"},
		Profile:                "workagent",
		PortalURL:              "http://127.0.0.1:8080",
		PublicBaseURL:          "https://workagent.example.com",
		ManagedSkillsRoot:      managedSkillsRoot,
		ManagedMCPServers:      []mcpruntime.Server{managedServer},
	}}
	spec := RuntimeSpec{SID: "S-1-5-21-1000", DataRoot: filepath.Join(root, "employee")}
	config := platform.runtimeFileConfig(spec, filepath.Join(root, "registration.token"))
	if config.PublishedPythonCommand != platform.config.PublishedPythonCommand {
		t.Fatal("trusted published Python interpreter was not projected")
	}
	if config.PublicBaseURL != "https://workagent.example.com" || config.PortalURL != "http://127.0.0.1:8080" {
		t.Fatal("public reminder origin and internal Portal URL must be projected independently")
	}
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

func TestRuntimeConfigProjectsProfessionalDatabaseURL(t *testing.T) {
	root := t.TempDir()
	endpoint := "http://127.0.0.1:18306/professional-database/mcp"
	platform := &WindowsPlatform{config: WindowsPlatformConfig{HarnessCommand: filepath.Join(root, "harness.exe"), HarnessEntrypoint: "index.js", Profile: "workagent", PortalURL: "http://127.0.0.1:8080", ProfessionalDatabaseURL: endpoint}}
	config := platform.runtimeFileConfig(RuntimeSpec{SID: "S-1-5-21-1000", DataRoot: filepath.Join(root, "employee")}, filepath.Join(root, "registration.token"))
	data, _ := json.Marshal(config)
	file := filepath.Join(root, "userhost.json")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := userhost.LoadFileConfig(file)
	if err != nil || loaded.ProfessionalDatabaseURL != endpoint {
		t.Fatalf("professional database endpoint not propagated: %v", err)
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

func TestPowerShellQueryParsesResultMarkerThroughCLIXMLNoise(t *testing.T) {
	// Real powershell.exe subprocess reproducing the server failure mode:
	// module-autoload progress records and CLIXML fragments pollute both
	// streams of a -NonInteractive SYSTEM process; only the explicit marker
	// line on stdout may be parsed.
	script := `$ProgressPreference='SilentlyContinue'; $InformationPreference='SilentlyContinue'; ` +
		`Write-Progress -Activity 'ScheduledTasks autoload' -Status 'loading' -PercentComplete 50; ` +
		`[Console]::Error.WriteLine('#< CLIXML'); ` +
		`[Console]::Error.WriteLine('<Objs Version="1.1.0.1"><Obj S="progress">noise</Obj></Objs>'); ` +
		`[Console]::WriteLine('#< CLIXML'); ` +
		`[Console]::WriteLine('<Objs>stdout progress noise</Objs>'); ` +
		`[Console]::WriteLine('` + powerShellResultMarker + `Running')`
	state, err := runPowerShellQuery(context.Background(), script, nil)
	if err != nil {
		t.Fatal(err)
	}
	if state != "Running" {
		t.Fatalf("parsed state %q through CLIXML noise", state)
	}
}

func TestPowerShellQueryFailsWithoutResultMarker(t *testing.T) {
	// A query that only emits noise must fail loudly instead of returning
	// garbage as a task state (the original regression parsed CLIXML as the
	// state and confirmed nothing).
	script := `[Console]::WriteLine('#< CLIXML'); [Console]::WriteLine('<Objs>noise</Objs>')`
	if _, err := runPowerShellQuery(context.Background(), script, nil); err == nil {
		t.Fatal("query without a result marker was accepted")
	}
}

func TestEmployeeTaskStateQueriesRealScheduledTask(t *testing.T) {
	// End-to-end: create a real scheduled task, then read its state through
	// the production employeeTaskState path (encoded command, restricted
	// environment, ScheduledTasks module autoload, marker parsing).
	name := fmt.Sprintf("WorkAgent3-QueryTest-%d", os.Getpid())
	create := exec.Command("schtasks", "/create", "/tn", name, "/tr", "cmd.exe /c exit", "/sc", "once", "/st", "00:00", "/f")
	if output, err := create.CombinedOutput(); err != nil {
		t.Skipf("scheduled task creation requires elevation: %v: %s", err, output)
	}
	defer exec.Command("schtasks", "/delete", "/tn", name, "/f").Run()
	state, err := employeeTaskState(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	if state != "Ready" && state != "Disabled" {
		t.Fatalf("real task state = %q", state)
	}
	// A missing task must fail loudly rather than report a bogus state:
	// COM method errors are only statement-terminating in PowerShell, so
	// without an explicit catch a null task would map to state "Unknown".
	if _, err := employeeTaskState(context.Background(), name+"-missing"); err == nil {
		t.Fatal("state query of a missing task was accepted")
	}
}

func TestStartScheduledTaskStartsRealTask(t *testing.T) {
	// End-to-end with the real Task Scheduler: a nil return must mean the task
	// is truly Running (the MultipleInstances IgnoreNew regression swallowed
	// starts silently). Requires elevation; skips otherwise.
	name := fmt.Sprintf("WorkAgent3-StartTest-%d", os.Getpid())
	create := exec.Command("schtasks", "/create", "/tn", name, "/tr", `C:\Windows\System32\cmd.exe /c ping -n 20 127.0.0.1`, "/sc", "once", "/st", "00:00", "/f")
	if output, err := create.CombinedOutput(); err != nil {
		t.Skipf("scheduled task creation requires elevation: %v: %s", err, output)
	}
	defer exec.Command("schtasks", "/delete", "/tn", name, "/f").Run()
	if err := startScheduledTask(context.Background(), name, startEmployeeTask, employeeTaskState); err != nil {
		t.Fatalf("real task start was not confirmed: %v", err)
	}
	state, err := employeeTaskState(context.Background(), name)
	if err != nil || state != "Running" {
		t.Fatalf("confirmed start but task state = %q, %v", state, err)
	}
	// Stop the task and wait for the asynchronous stop to settle; a repeated
	// start must succeed again (this is exactly the stop/start race window).
	if output, err := exec.Command("schtasks", "/end", "/tn", name).CombinedOutput(); err != nil {
		t.Fatalf("stop real task: %v: %s", err, output)
	}
	if err := startScheduledTask(context.Background(), name, startEmployeeTask, employeeTaskState); err != nil {
		t.Fatalf("restart after asynchronous stop was not confirmed: %v", err)
	}
	if output, err := exec.Command("schtasks", "/end", "/tn", name).CombinedOutput(); err != nil {
		t.Fatalf("final stop: %v: %s", err, output)
	}
}

func TestStopInstalledRuntimeStopsRealTask(t *testing.T) {
	// End-to-end through the production StopInstalledRuntime (COM API): a
	// running task must be stopped, and stopping a missing task must error
	// (the lifecycle flows rely on that to detect a broken install).
	suffix := fmt.Sprintf("%d", os.Getpid())
	name := "WorkAgent3-StopTest-" + suffix
	create := exec.Command("schtasks", "/create", "/tn", name, "/tr", `C:\Windows\System32\cmd.exe /c ping -n 20 127.0.0.1`, "/sc", "once", "/st", "00:00", "/f")
	if output, err := create.CombinedOutput(); err != nil {
		t.Skipf("scheduled task creation requires elevation: %v: %s", err, output)
	}
	defer exec.Command("schtasks", "/delete", "/tn", name, "/f").Run()
	platform := &WindowsPlatform{}
	if err := startScheduledTask(context.Background(), name, startEmployeeTask, employeeTaskState); err != nil {
		t.Fatalf("start real task: %v", err)
	}
	if err := platform.StopInstalledRuntime(context.Background(), "StopTest-"+suffix); err != nil {
		t.Fatalf("stop real task: %v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		state, err := employeeTaskState(context.Background(), name)
		if err != nil {
			t.Fatal(err)
		}
		if state != "Running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("task still Running after StopInstalledRuntime")
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err := platform.StopInstalledRuntime(context.Background(), "StopTest-missing-"+suffix); err == nil {
		t.Fatal("stopping a missing task was accepted")
	}
}

func TestRemoveInstalledRuntimeDeletesRealTaskIdempotently(t *testing.T) {
	// End-to-end through the production RemoveInstalledRuntime (COM API):
	// deleting an existing task must remove it, and deleting a missing task
	// must succeed (remove flows are invoked on partially installed runtimes).
	suffix := fmt.Sprintf("%d", os.Getpid())
	name := "WorkAgent3-RemoveTest-" + suffix
	create := exec.Command("schtasks", "/create", "/tn", name, "/tr", "cmd.exe /c exit", "/sc", "once", "/st", "00:00", "/f")
	if output, err := create.CombinedOutput(); err != nil {
		t.Skipf("scheduled task creation requires elevation: %v: %s", err, output)
	}
	platform := &WindowsPlatform{}
	if err := platform.RemoveInstalledRuntime(context.Background(), "RemoveTest-"+suffix); err != nil {
		t.Fatalf("remove real task: %v", err)
	}
	if _, err := employeeTaskState(context.Background(), name); err == nil {
		t.Fatal("task still exists after RemoveInstalledRuntime")
	}
	if err := platform.RemoveInstalledRuntime(context.Background(), "RemoveTest-"+suffix); err != nil {
		t.Fatalf("repeated remove of a missing task: %v", err)
	}
}
