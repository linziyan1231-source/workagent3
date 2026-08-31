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
	"time"
	"unicode/utf16"

	"workagent3/internal/userhost"
	"workagent3/internal/winutil"
)

type WindowsPlatformConfig struct {
	DataRootBase         string
	UserHostExecutable   string
	HarnessCommand       string
	HarnessEntrypoint    string
	CodexCommand         string
	KimiCommand          string
	HarnessArguments     []string
	Profile              string
	HarnessProfileSource string
	PortalURL            string
	Limits               winutil.JobLimits
}

type WindowsPlatform struct{ config WindowsPlatformConfig }

func NewWindowsPlatform(config WindowsPlatformConfig) (*WindowsPlatform, error) {
	if !filepath.IsAbs(config.DataRootBase) || !filepath.IsAbs(config.UserHostExecutable) || !filepath.IsAbs(config.HarnessCommand) || !filepath.IsAbs(config.HarnessProfileSource) {
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
	return &WindowsPlatform{config: config}, nil
}

func (p *WindowsPlatform) EnsureAccount(_ context.Context, username string, password []byte) (Account, error) {
	sid, canonical, err := winutil.EnsureLocalStandardAccount(username, password)
	if err != nil {
		return Account{}, err
	}
	if err := winutil.EnsureBatchLogonRight(sid); err != nil {
		return Account{}, err
	}
	return Account{SID: sid, Canonical: canonical}, nil
}

func (p *WindowsPlatform) EnsureProfile(_ context.Context, account Account, username string, password []byte) error {
	return winutil.EnsureProfileForAccount(account.SID, username, password)
}

func (p *WindowsPlatform) EnsurePrivateDataRoot(_ context.Context, account Account) (string, error) {
	root := filepath.Join(p.config.DataRootBase, account.SID)
	if err := winutil.EnsurePrivateTree(root, account.SID); err != nil {
		return "", err
	}
	if err := winutil.EnsureSharedOwnerLayout(p.config.DataRootBase, account.SID); err != nil {
		return "", err
	}
	profileDirectory := filepath.Join(root, "dsh-home", "profiles", p.config.Profile)
	if err := projectHarnessProfile(p.config.HarnessProfileSource, profileDirectory); err != nil {
		return "", fmt.Errorf("project Harness profile: %w", err)
	}
	return root, nil
}

func (p *WindowsPlatform) InstallRuntime(ctx context.Context, spec RuntimeSpec, password []byte) error {
	runtimeDirectory := filepath.Join(spec.DataRoot, "runtime")
	if err := os.MkdirAll(runtimeDirectory, 0o700); err != nil {
		return err
	}
	credentialPath := filepath.Join(runtimeDirectory, "portal-registration.token")
	configPath := filepath.Join(runtimeDirectory, "userhost.json")
	if err := writeAtomic(credentialPath, []byte(spec.RegistrationCredential)); err != nil {
		return fmt.Errorf("write registration credential: %w", err)
	}
	config := userhost.FileConfig{
		SID: spec.SID, DataRoot: spec.DataRoot, HarnessCommand: p.config.HarnessCommand,
		CodexCommand: p.config.CodexCommand, KimiCommand: p.config.KimiCommand,
		HarnessArguments: append([]string{filepath.Join(spec.DataRoot, "dsh-home", "profiles", p.config.Profile, p.config.HarnessEntrypoint)}, p.config.HarnessArguments...), Profile: p.config.Profile,
		PortalURL: p.config.PortalURL, RegistrationCredentialFile: credentialPath,
		Limits: p.config.Limits,
	}
	payload, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(configPath, payload); err != nil {
		return fmt.Errorf("write UserHost configuration: %w", err)
	}
	return registerScheduledTask(ctx, scheduledTaskSpec{
		Name: taskName(spec.SID), Username: spec.CanonicalUsername, Executable: p.config.UserHostExecutable,
		ConfigPath: configPath, WorkingDirectory: filepath.Dir(p.config.UserHostExecutable),
	}, password)
}

func (p *WindowsPlatform) StartRuntime(ctx context.Context, spec RuntimeSpec) error {
	script := `Start-ScheduledTask -TaskName $env:WA3_TASK`
	if err := runPowerShell(ctx, script, map[string]string{"WA3_TASK": taskName(spec.SID)}, nil); err != nil {
		return err
	}
	return waitForRuntimeLease(ctx, p.config.PortalURL, spec.SID, spec.RegistrationCredential, 45*time.Second)
}

func (p *WindowsPlatform) StopInstalledRuntime(ctx context.Context, sid string) error {
	return runPowerShell(ctx, `$task=Get-ScheduledTask -TaskName $env:WA3_TASK -ErrorAction Stop; if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $env:WA3_TASK -ErrorAction Stop }`, map[string]string{"WA3_TASK": taskName(sid)}, nil)
}

func (p *WindowsPlatform) StartInstalledRuntime(ctx context.Context, sid string) error {
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
	if err := runPowerShell(ctx, `Start-ScheduledTask -TaskName $env:WA3_TASK -ErrorAction Stop`, map[string]string{"WA3_TASK": taskName(sid)}, nil); err != nil {
		return err
	}
	return waitForRuntimeLease(ctx, p.config.PortalURL, sid, value, 45*time.Second)
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
	script := `$password=[Console]::In.ReadLine(); $action=New-ScheduledTaskAction -Execute $env:WA3_EXEC -Argument ('--config "'+$env:WA3_CONFIG+'"') -WorkingDirectory $env:WA3_WORK; $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero); Register-ScheduledTask -TaskName $env:WA3_TASK -Action $action -Settings $settings -User $env:WA3_USER -Password $password -RunLevel Limited -Force | Out-Null`
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
		message := strings.TrimSpace(output.String())
		if len(message) > 2048 {
			message = message[:2048]
		}
		return fmt.Errorf("Windows Task Scheduler command failed: %w: %s", err, message)
	}
	return nil
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
