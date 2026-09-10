//go:build windows

package employee

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"workagent3/internal/contracts"
	"workagent3/internal/credentialbroker"
	"workagent3/internal/employeesecrets"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/nativeauth"
	"workagent3/internal/store"
	"workagent3/internal/userhost"
	"workagent3/internal/userhostlauncher"
	"workagent3/internal/winutil"
)

type WindowsPlatformConfig struct {
	MaxRunningRuntimes   int
	StorageLimits        *contracts.StorageLimits
	CredentialRoot       string
	LauncherExecutable   string
	LaunchManifestRoot   string
	DataRootBase         string
	UserHostExecutable   string
	HarnessCommand       string
	HarnessEntrypoint    string
	CodexCommand         string
	KimiCommand          string
	HarnessArguments     []string
	Profile              string
	HarnessProfileSource string
	ManagedSkillsRoot    string
	ManagedToolsRoot     string
	ManagedMCPServers    []mcpruntime.Server
	PortalURL            string
	PublicBaseURL        string
	Limits               winutil.JobLimits
	NativeModels         NativeModelProvisioner
	// HarnessModel and ModelGatewayBaseURL mirror the model gateway
	// configuration so each SID UserHost can point its Harness at the shared
	// CLIProxyAPI loopback with the configured Codex model.
	HarnessModel        string
	ModelGatewayBaseURL string
}

type NativeModelProvisioner interface {
	Provision(context.Context, string, string) (nativeauth.Bundle, error)
}

type WindowsPlatform struct {
	config  WindowsPlatformConfig
	startMu sync.Mutex
}

func NewWindowsPlatform(config WindowsPlatformConfig) (*WindowsPlatform, error) {
	if !filepath.IsAbs(config.DataRootBase) || !filepath.IsAbs(config.UserHostExecutable) || !filepath.IsAbs(config.HarnessCommand) || !filepath.IsAbs(config.HarnessProfileSource) || !filepath.IsAbs(config.ManagedSkillsRoot) {
		return nil, errors.New("employee data root, runtime executables, and Harness profile source must be absolute")
	}
	if config.Profile == "" || config.PortalURL == "" {
		return nil, errors.New("Harness profile and Portal URL are required")
	}
	entrypoint := filepath.Clean(filepath.FromSlash(config.HarnessEntrypoint))
	if config.HarnessEntrypoint == "" || !filepath.IsLocal(entrypoint) || entrypoint == "." {
		return nil, errors.New("Harness entrypoint must be relative to the released profile")
	}
	config.HarnessEntrypoint = entrypoint
	for _, software := range []string{config.UserHostExecutable, config.HarnessCommand, config.HarnessProfileSource, config.CodexCommand, config.KimiCommand, config.ManagedSkillsRoot, config.ManagedToolsRoot} {
		if software == "" {
			continue
		}
		relative, err := filepath.Rel(config.DataRootBase, software)
		if err == nil && (relative == "." || filepath.IsLocal(relative)) {
			return nil, errors.New("public software must be outside employee and shared storage quotas")
		}
	}
	return &WindowsPlatform{config: config}, nil
}

func (p *WindowsPlatform) vault() (*employeesecrets.Vault, error) {
	sid, err := winutil.CurrentSID()
	if err != nil {
		return nil, err
	}
	if sid != "S-1-5-18" {
		return nil, errors.New("managed Windows credentials require the SYSTEM service identity")
	}
	if !filepath.IsAbs(p.config.CredentialRoot) {
		return nil, errors.New("absolute credential root is required")
	}
	if err := winutil.EnsureServiceTree(p.config.CredentialRoot, false); err != nil {
		return nil, err
	}
	return employeesecrets.New(p.config.CredentialRoot, credentialbroker.NewUserProtector()), nil
}

func (p *WindowsPlatform) EnsureAccount(_ context.Context, username string, password []byte) (Account, error) {
	lock, err := winutil.AcquireInstanceLock("WorkAgent3-account-" + strings.ToLower(username))
	if err != nil {
		return Account{}, err
	}
	defer lock.Close()
	vault, err := p.vault()
	if err != nil {
		return Account{}, err
	}
	id := "new-" + strings.ToLower(username)
	if sid, _, lookupErr := winutil.LookupAccount(`.\` + username); lookupErr == nil {
		id = sid
	}
	saved, err := vault.Read(id)
	if errors.Is(err, employeesecrets.ErrMissing) && strings.HasPrefix(id, "new-") {
		saved = employeesecrets.Record{Username: username, Password: append([]byte(nil), password...)}
		err = vault.Write(id, saved)
	} else if errors.Is(err, employeesecrets.ErrMissing) {
		// A creation interrupted after NetUserAdd still has its pre-written secret.
		saved, err = vault.Read("new-" + strings.ToLower(username))
	}
	if err != nil {
		return Account{}, err
	}
	defer saved.Clear()
	if saved.Phase != "" {
		return Account{}, errors.New("Windows credential maintenance is pending")
	}
	password = saved.Password
	sid, canonical, err := winutil.EnsureLocalStandardAccount(username, password)
	if err != nil {
		return Account{}, err
	}
	if err := winutil.EnsureBatchLogonRight(sid); err != nil {
		return Account{}, err
	}
	saved.SID = sid
	saved.Username = canonical
	if err := vault.Write(sid, saved); err != nil {
		return Account{}, err
	}
	if err := vault.Remove("new-" + strings.ToLower(username)); err != nil {
		return Account{}, err
	}
	return Account{SID: sid, Canonical: canonical}, nil
}

func (p *WindowsPlatform) EnsureProfile(_ context.Context, account Account, username string, password []byte) error {
	return winutil.EnsureProfileForAccount(account.SID, username, password)
}

func (p *WindowsPlatform) EnsurePrivateDataRoot(ctx context.Context, account Account) (string, error) {
	root := filepath.Join(p.config.DataRootBase, account.SID)
	if err := winutil.EnsurePrivateTree(root, account.SID); err != nil {
		return "", err
	}
	if err := winutil.EnsureSharedOwnerLayout(p.config.DataRootBase, account.SID); err != nil {
		return "", err
	}
	if err := p.ensureStorageLimits(ctx, account.SID); err != nil {
		return "", err
	}
	profileDirectory := filepath.Join(root, "dsh-home", "profiles", p.config.Profile)
	if err := projectHarnessProfile(p.config.HarnessProfileSource, profileDirectory); err != nil {
		return "", fmt.Errorf("project Harness profile: %w", err)
	}
	// Provisioning rotates the SID downstream keys in place, so every Add and
	// Repair stages a fresh bundle; UserHost then replays the ordered delivery
	// (native credentials, broker record, Harness re-projection) at startup.
	if p.config.NativeModels != nil {
		bundle, err := p.config.NativeModels.Provision(ctx, account.Canonical, account.SID)
		if err != nil {
			return "", fmt.Errorf("provision native model access: %w", err)
		}
		if err := nativeauth.Stage(root, bundle); err != nil {
			return "", fmt.Errorf("stage SID-private native model access: %w", err)
		}
	}
	return root, nil
}

func (p *WindowsPlatform) InstallRuntime(ctx context.Context, spec RuntimeSpec, password []byte) error {
	vault, err := p.vault()
	if err != nil {
		return err
	}
	saved, err := vault.Read(spec.SID)
	if err != nil {
		return err
	}
	defer saved.Clear()
	if saved.Phase != "" {
		return errors.New("Windows credential maintenance is pending")
	}
	password = saved.Password
	runtimeDirectory := filepath.Join(spec.DataRoot, "runtime")
	if err := os.MkdirAll(runtimeDirectory, 0o700); err != nil {
		return err
	}
	credentialPath := filepath.Join(runtimeDirectory, "portal-registration.token")
	configPath := filepath.Join(runtimeDirectory, "userhost.json")
	if err := writeAtomic(credentialPath, []byte(spec.RegistrationCredential)); err != nil {
		return fmt.Errorf("write registration credential: %w", err)
	}
	config := p.runtimeFileConfig(spec, credentialPath)
	payload, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(configPath, payload); err != nil {
		return fmt.Errorf("write UserHost configuration: %w", err)
	}
	return p.registerLauncher(ctx, spec.SID, spec.CanonicalUsername, configPath, password)
}

func (p *WindowsPlatform) registerLauncher(ctx context.Context, sid, username, configPath string, password []byte) error {
	if !filepath.IsAbs(p.config.LauncherExecutable) || !filepath.IsAbs(p.config.LaunchManifestRoot) {
		return errors.New("fixed launcher and manifest root are required")
	}
	if err := winutil.EnsureServiceTree(p.config.LaunchManifestRoot, true); err != nil {
		return err
	}
	manifestPath := filepath.Join(p.config.LaunchManifestRoot, sid+".json")
	payload, _ := json.Marshal(userhostlauncher.Manifest{Executable: p.config.UserHostExecutable, Config: configPath, SID: sid})
	if err := writeAtomic(manifestPath, payload); err != nil {
		return err
	}
	return registerScheduledTask(ctx, scheduledTaskSpec{Name: taskName(sid), Username: username, Executable: p.config.LauncherExecutable, ConfigPath: manifestPath, WorkingDirectory: filepath.Dir(p.config.LauncherExecutable)}, password)
}

func (p *WindowsPlatform) CheckManagedCredential(user store.User) error {
	vault, err := p.vault()
	if err != nil {
		return err
	}
	saved, err := vault.Read(user.SID)
	if err != nil {
		return err
	}
	defer saved.Clear()
	if saved.Phase != "" {
		return errors.New("Windows credential maintenance is pending")
	}
	token, err := winutil.LogonManagedUser(localWindowsUsername(user), saved.Password)
	if err != nil {
		return err
	}
	token.Close()
	return nil
}

func (p *WindowsPlatform) runtimeFileConfig(spec RuntimeSpec, credentialPath string) userhost.FileConfig {
	return userhost.FileConfig{
		SID: spec.SID, DataRoot: spec.DataRoot, HarnessCommand: p.config.HarnessCommand,
		CodexCommand: p.config.CodexCommand, KimiCommand: p.config.KimiCommand,
		HarnessArguments: append([]string{filepath.Join(p.config.HarnessProfileSource, p.config.HarnessEntrypoint)}, p.config.HarnessArguments...), Profile: p.config.Profile,
		PublicBaseURL: p.config.PublicBaseURL,
		PortalURL:     p.config.PortalURL, RegistrationCredentialFile: credentialPath,
		ManagedSkillsRoot: p.config.ManagedSkillsRoot, ManagedToolsRoot: p.config.ManagedToolsRoot,
		ManagedMCPServers: expandManagedMCPServers(p.config.ManagedMCPServers, spec),
		Limits:            p.config.Limits,
		HarnessModel:      p.config.HarnessModel, ModelGatewayBaseURL: p.config.ModelGatewayBaseURL,
	}
}

func expandManagedMCPServers(servers []mcpruntime.Server, spec RuntimeSpec) []mcpruntime.Server {
	variables := map[string]string{
		"${SID}":            spec.SID,
		"${DATA_ROOT}":      spec.DataRoot,
		"${WORKSPACE_ROOT}": filepath.Join(spec.DataRoot, "workspace"),
	}
	expand := func(value string) string {
		for variable, replacement := range variables {
			value = strings.ReplaceAll(value, variable, replacement)
		}
		return value
	}
	result := make([]mcpruntime.Server, len(servers))
	for index, server := range servers {
		result[index] = server
		result[index].Transport.Command = expand(server.Transport.Command)
		result[index].Transport.URL = expand(server.Transport.URL)
		result[index].Transport.Args = make([]string, len(server.Transport.Args))
		for argumentIndex, argument := range server.Transport.Args {
			result[index].Transport.Args[argumentIndex] = expand(argument)
		}
	}
	return result
}

func (p *WindowsPlatform) StartRuntime(ctx context.Context, spec RuntimeSpec) error {
	p.startMu.Lock()
	defer p.startMu.Unlock()
	if err := p.checkRuntimeCapacity(ctx, spec.SID); err != nil {
		return err
	}
	if err := startScheduledTask(ctx, taskName(spec.SID), startEmployeeTask, employeeTaskState); err != nil {
		return err
	}
	return waitForRuntimeLease(ctx, p.config.PortalURL, spec.SID, spec.RegistrationCredential, 45*time.Second)
}

// StopInstalledRuntime and RemoveInstalledRuntime use the Task Scheduler
// COM API for the same reason as employeeTaskState: the ScheduledTasks
// module's Get-ScheduledTask -TaskName query breaks with HRESULT
// 0x80070057 on machines hosting a task the CIM provider cannot parse,
// which would make employee disable/remove fail on such machines.
func (p *WindowsPlatform) StopInstalledRuntime(ctx context.Context, sid string) error {
	// A missing task must be an explicit failure. COM method errors in
	// PowerShell are only statement-terminating, so an uncaught GetTask
	// failure would leave $task null and silently continue; catch and exit
	// non-zero instead.
	script := `$ProgressPreference='SilentlyContinue'; $InformationPreference='SilentlyContinue'; ` +
		`$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); ` +
		`try { $task=$service.GetFolder('\').GetTask($env:WA3_TASK) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }; ` +
		`if ([int]$task.State -eq 4) { $task.Stop(0) }; ` +
		`for($i=0;$i -lt 100 -and [int]$task.State -eq 4;$i++){Start-Sleep -Milliseconds 100}; if([int]$task.State -eq 4){throw 'Employee task did not stop'}`
	return runPowerShell(ctx, script, map[string]string{"WA3_TASK": taskName(sid)}, nil)
}

func (p *WindowsPlatform) StartInstalledRuntime(ctx context.Context, sid string) error {
	p.startMu.Lock()
	defer p.startMu.Unlock()
	if err := p.checkRuntimeCapacity(ctx, sid); err != nil {
		return err
	}
	if err := p.ensureStorageLimits(ctx, sid); err != nil {
		return err
	}
	runtimeDirectory := filepath.Join(p.config.DataRootBase, sid, "runtime")
	credential, err := os.ReadFile(filepath.Join(runtimeDirectory, "portal-registration.token"))
	if err != nil {
		return fmt.Errorf("read employee runtime registration credential: %w", err)
	}
	defer zero(credential)
	value := strings.TrimSpace(string(credential))
	if value == "" {
		return errors.New("employee runtime registration credential is empty")
	}
	if err := startScheduledTask(ctx, taskName(sid), startEmployeeTask, employeeTaskState); err != nil {
		return err
	}
	return waitForRuntimeLease(ctx, p.config.PortalURL, sid, value, 45*time.Second)
}

func (p *WindowsPlatform) UpdateInstalledLimits(_ context.Context, sid string, limits winutil.JobLimits) error {
	if err := winutil.ValidateJobLimits(limits); err != nil {
		return err
	}
	configPath := filepath.Join(p.config.DataRootBase, sid, "runtime", "userhost.json")
	payload, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("read UserHost configuration: %w", err)
	}
	var config userhost.FileConfig
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return fmt.Errorf("decode UserHost configuration: %w", err)
	}
	if !strings.EqualFold(config.SID, sid) {
		return errors.New("UserHost configuration SID does not match the employee")
	}
	config.Limits = limits
	payload, err = json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(configPath, append(payload, '\n'))
}

func (p *WindowsPlatform) RemoveInstalledRuntime(ctx context.Context, sid string) error {
	// powershell.exe -EncodedCommand exits 1 when any error record was
	// written, even a caught one, so the idempotent "task already gone"
	// path must exit 0 explicitly.
	script := `$ProgressPreference='SilentlyContinue'; $InformationPreference='SilentlyContinue'; ` +
		`$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); ` +
		`$folder=$service.GetFolder('\'); ` +
		`try { $folder.GetTask($env:WA3_TASK) | Out-Null } catch { exit 0 }; ` +
		`$folder.DeleteTask($env:WA3_TASK, 0)`
	return runPowerShell(ctx, script, map[string]string{"WA3_TASK": taskName(sid)}, nil)
}

func (p *WindowsPlatform) RepairInstalledRuntime(ctx context.Context, user store.User, password []byte) error {
	if len(password) > 0 {
		return errors.New("repair uses managed credentials; supplied Windows passwords are not accepted")
	}
	account, err := p.EnsureAccount(ctx, localWindowsUsername(user), password)
	if err != nil {
		return err
	}
	if !strings.EqualFold(account.SID, user.SID) {
		return errors.New("Windows account SID changed during repair")
	}
	if err := p.EnsureProfile(ctx, account, user.Username, password); err != nil {
		return err
	}
	dataRoot, err := p.EnsurePrivateDataRoot(ctx, account)
	if err != nil {
		return err
	}
	credentialPath := filepath.Join(dataRoot, "runtime", "portal-registration.token")
	credential, err := os.ReadFile(credentialPath)
	if err != nil {
		return fmt.Errorf("read retained Runtime registration credential: %w", err)
	}
	defer zero(credential)
	registrationCredential := strings.TrimSpace(string(credential))
	if registrationCredential == "" {
		return errors.New("retained Runtime registration credential is empty")
	}
	spec := RuntimeSpec{SID: user.SID, CanonicalUsername: account.Canonical, DataRoot: dataRoot, RegistrationCredential: registrationCredential}
	if err := p.InstallRuntime(ctx, spec, password); err != nil {
		return err
	}
	return p.StartRuntime(ctx, spec)
}

func (p *WindowsPlatform) RenameInstalledAccount(ctx context.Context, user store.User, newUsername string, password []byte) (string, error) {
	if err := winutil.ValidateLocalUsername(newUsername); err != nil {
		return "", err
	}
	oldUsername := localWindowsUsername(user)
	if !strings.EqualFold(oldUsername, newUsername) {
		if sid, canonical, err := winutil.LookupAccount(`.\` + newUsername); err == nil {
			if !strings.EqualFold(sid, user.SID) {
				return "", errors.New("new Windows username belongs to a different SID")
			}
			user.WindowsUsername = canonical
		} else {
			script := `Rename-LocalUser -Name $env:WA3_OLD_USER -NewName $env:WA3_NEW_USER -ErrorAction Stop`
			if err := runPowerShell(ctx, script, map[string]string{"WA3_OLD_USER": oldUsername, "WA3_NEW_USER": newUsername}, nil); err != nil {
				return "", err
			}
		}
	}
	sid, canonical, err := winutil.LookupAccount(`.\` + newUsername)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(sid, user.SID) {
		return "", errors.New("Windows account SID changed during rename")
	}
	user.WindowsUsername = canonical
	if err := p.RepairInstalledRuntime(ctx, user, password); err != nil {
		return "", err
	}
	return canonical, nil
}

func localWindowsUsername(user store.User) string {
	value := strings.TrimSpace(user.WindowsUsername)
	if value == "" {
		value = user.Username
	}
	if _, name, found := strings.Cut(value, `\`); found {
		return name
	}
	return value
}

func (p *WindowsPlatform) DeleteRetainedEmployee(ctx context.Context, user store.User) error {
	target, err := retainedEmployeeDataRoot(p.config.DataRootBase, user.SID)
	if err != nil {
		return err
	}
	if err := p.RemoveInstalledRuntime(ctx, user.SID); err != nil {
		return err
	}
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("employee data root is not a normal directory")
		}
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("delete retained employee data: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := winutil.DeleteManagedLocalAccount(localWindowsUsername(user), user.SID); err != nil {
		return err
	}
	vault, err := p.vault()
	if err != nil {
		return err
	}
	if err := vault.Remove(user.SID); err != nil {
		return err
	}
	err = os.Remove(filepath.Join(p.config.LaunchManifestRoot, user.SID+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func retainedEmployeeDataRoot(baseRoot, sid string) (string, error) {
	base, err := filepath.Abs(filepath.Clean(baseRoot))
	if err != nil {
		return "", err
	}
	target, err := filepath.Abs(filepath.Join(base, sid))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(base, target)
	if err != nil || relative != sid || filepath.Dir(target) != base || !strings.HasPrefix(sid, "S-1-") {
		return "", errors.New("employee data root is not an exact SID child")
	}
	return target, nil
}

func waitForRuntimeLease(ctx context.Context, portalURL, sid, credential string, timeout time.Duration) error {
	endpoint := strings.TrimRight(portalURL, "/") + "/internal/runtime/lease?sid=" + url.QueryEscape(sid)
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		request.Header.Set("Authorization", "Bearer "+credential)
		if response, err := client.Do(request); err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusNoContent {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("employee runtime did not register before startup timeout")
		case <-ticker.C:
		}
	}
}

type scheduledTaskSpec struct{ Name, Username, Executable, ConfigPath, WorkingDirectory string }

func registerScheduledTask(ctx context.Context, spec scheduledTaskSpec, password []byte) error {
	if len(password) == 0 {
		return errors.New("Windows task password is required")
	}
	script := `$ErrorActionPreference='Stop'; $password=[Console]::In.ReadLine(); $action=New-ScheduledTaskAction -Execute $env:WA3_EXEC -Argument ('--config "'+$env:WA3_CONFIG+'"') -WorkingDirectory $env:WA3_WORK; $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero); $trigger=New-ScheduledTaskTrigger -AtStartup; Register-ScheduledTask -TaskName $env:WA3_TASK -Action $action -Trigger $trigger -Settings $settings -User $env:WA3_USER -Password $password -RunLevel Limited -Force | Out-Null; $scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect(); $scheduler.GetFolder('\').GetTask($env:WA3_TASK).SetSecurityDescriptor('D:P(A;;GA;;;SY)(A;;GR;;;BA)',0)`
	environment := map[string]string{"WA3_TASK": spec.Name, "WA3_USER": spec.Username, "WA3_EXEC": spec.Executable, "WA3_CONFIG": spec.ConfigPath, "WA3_WORK": spec.WorkingDirectory}
	input := append(append([]byte(nil), password...), '\n')
	defer zero(input)
	return runPowerShell(ctx, script, environment, input)
}

func runPowerShell(ctx context.Context, script string, values map[string]string, input []byte) error {
	command := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script))
	command.Env = restrictedEnvironment(values)
	command.Stdin = bytes.NewReader(input)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		return fmt.Errorf("Windows Task Scheduler command failed: %w: %s", err, powerShellOutput(output))
	}
	return nil
}

// startEmployeeTask and employeeTaskState are the scheduled task primitives
// behind startScheduledTask; they are variables so tests can inject fakes.
var startEmployeeTask = func(ctx context.Context, name string) error {
	return runPowerShell(ctx, `Start-ScheduledTask -TaskName $env:WA3_TASK -ErrorAction Stop`, map[string]string{"WA3_TASK": name}, nil)
}

// powerShellResultMarker prefixes the single result line a query script
// prints via [Console]::WriteLine. stdout and stderr are captured separately
// and only an explicit marker line on stdout is accepted as the result: a
// -NonInteractive PowerShell process can serialize progress records and
// CLIXML fragments into its output streams, so positional "trim the output"
// parsing never sees a clean value.
const powerShellResultMarker = "WA3-RESULT:"

// employeeTaskState reads the task state through the Task Scheduler COM API
// (Schedule.Service) rather than the ScheduledTasks module cmdlets for two
// reasons: New-Object -ComObject triggers no module autoload (the autoload
// progress records were the CLIXML noise source under SYSTEM), and the
// module's Get-ScheduledTask -TaskName query breaks with HRESULT 0x80070057
// on machines hosting a task the CIM provider cannot parse, while the COM
// API (which schtasks itself uses) stays reliable.
var employeeTaskState = func(ctx context.Context, name string) (string, error) {
	// Catch GetTask failures explicitly: COM method errors are only
	// statement-terminating in PowerShell, so without the catch a missing
	// task would leave $task null, map [int]$null.State to 0, and report a
	// bogus "Unknown" state with exit code 0.
	script := `$ProgressPreference='SilentlyContinue'; $InformationPreference='SilentlyContinue'; ` +
		`$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); ` +
		`try { $task=$service.GetFolder('\').GetTask($env:WA3_TASK) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }; ` +
		`$names=@{0='Unknown';1='Disabled';2='Queued';3='Ready';4='Running'}; $state=$names[[int]$task.State]; ` +
		`if ($null -eq $state) { $state='Unknown' }; [Console]::WriteLine('` + powerShellResultMarker + `' + $state)`
	return runPowerShellQuery(ctx, script, map[string]string{"WA3_TASK": name})
}

func runPowerShellQuery(ctx context.Context, script string, values map[string]string) (string, error) {
	command := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script))
	command.Env = restrictedEnvironment(values)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		message := powerShellOutput(stderr)
		if message == "" {
			message = powerShellOutput(stdout)
		}
		return "", fmt.Errorf("Windows Task Scheduler query failed: %w: %s", err, message)
	}
	// Only the explicit marker line on stdout is the result; surrounding
	// CLIXML/progress noise is ignored. The last marker line wins.
	var result string
	found := false
	for _, line := range strings.Split(stdout.String(), "\n") {
		if value, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), powerShellResultMarker); ok {
			result, found = strings.TrimSpace(value), true
		}
	}
	if !found {
		return "", fmt.Errorf("Windows Task Scheduler query produced no result line: %s", powerShellOutput(stdout))
	}
	return result, nil
}

func powerShellOutput(output bytes.Buffer) string {
	message := strings.TrimSpace(output.String())
	if len(message) > 2048 {
		message = message[:2048]
	}
	return message
}

func encodedPowerShell(script string) string {
	encoded := utf16.Encode([]rune(script))
	buffer := make([]byte, len(encoded)*2)
	for index, value := range encoded {
		binary.LittleEndian.PutUint16(buffer[index*2:], value)
	}
	return base64.StdEncoding.EncodeToString(buffer)
}

func restrictedEnvironment(values map[string]string) []string {
	allowed := map[string]bool{"SystemRoot": true, "WINDIR": true, "PATH": true, "PATHEXT": true, "TEMP": true, "TMP": true}
	result := make([]string, 0, len(allowed)+len(values))
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		for allowedKey := range allowed {
			if strings.EqualFold(key, allowedKey) {
				result = append(result, item)
				break
			}
		}
	}
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}

func taskName(sid string) string { return "WorkAgent3-" + sid }

func writeAtomic(path string, payload []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".workagent-write-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if _, err := os.Lstat(path); err == nil {
		if err := os.Remove(path); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(temporaryPath, path)
}
