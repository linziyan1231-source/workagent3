//go:build !windows

package employee

import (
	"context"
	"errors"

	"workagent3/internal/contracts"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

type WindowsPlatformConfig struct {
	MaxRunningRuntimes      int
	StorageLimits           *contracts.StorageLimits
	CredentialRoot          string
	LauncherExecutable      string
	LaunchManifestRoot      string
	DataRootBase            string
	UserHostExecutable      string
	HarnessCommand          string
	HarnessEntrypoint       string
	CodexCommand            string
	KimiCommand             string
	HarnessArguments        []string
	Profile                 string
	HarnessProfileSource    string
	ManagedSkillsRoot       string
	ManagedToolsRoot        string
	ManagedMCPServers       []mcpruntime.Server
	ProfessionalDatabaseURL string
	PortalURL               string
	PublicBaseURL           string
	Limits                  winutil.JobLimits
	NativeModels            NativeModelProvisioner
	HarnessModel            string
	ModelGatewayBaseURL     string
}

type NativeModelProvisioner interface{}

func (*WindowsPlatform) InspectWindowsCredentialMigration(context.Context, store.User, uint32) (int, error) {
	return 0, errors.New("Windows required")
}

func (*WindowsPlatform) RestoreWindowsCredential(store.User, []byte, string) error {
	return errors.New("Windows required")
}

type WindowsPlatform struct{}

func NewWindowsPlatform(WindowsPlatformConfig) (*WindowsPlatform, error) {
	return nil, errors.New("employee provisioning is only available on Windows")
}

func (*WindowsPlatform) EnsureAccount(context.Context, string, []byte) (Account, error) {
	return Account{}, errors.New("employee provisioning is only available on Windows")
}
func (*WindowsPlatform) MaintainWindowsCredential(context.Context, store.User, uint32, bool) error {
	return errors.New("Windows required")
}
func (*WindowsPlatform) BackupWindowsCredential(store.User, []byte, string) error {
	return errors.New("Windows required")
}

func (*WindowsPlatform) EnsureProfile(context.Context, Account, string, []byte) error {
	return errors.New("employee provisioning is only available on Windows")
}

func (*WindowsPlatform) EnsurePrivateDataRoot(context.Context, Account) (string, error) {
	return "", errors.New("employee provisioning is only available on Windows")
}

func (*WindowsPlatform) InstallRuntime(context.Context, RuntimeSpec, []byte) error {
	return errors.New("employee provisioning is only available on Windows")
}

func (*WindowsPlatform) StartRuntime(context.Context, RuntimeSpec) error {
	return errors.New("employee provisioning is only available on Windows")
}

func (*WindowsPlatform) StopInstalledRuntime(context.Context, string) error {
	return errors.New("employee lifecycle is only available on Windows")
}

func (*WindowsPlatform) StartInstalledRuntime(context.Context, string) error {
	return errors.New("employee lifecycle is only available on Windows")
}

func (*WindowsPlatform) UpdateInstalledLimits(context.Context, string, winutil.JobLimits) error {
	return errors.New("employee lifecycle is only available on Windows")
}

func (*WindowsPlatform) RemoveInstalledRuntime(context.Context, string) error {
	return errors.New("employee lifecycle is only available on Windows")
}

func (*WindowsPlatform) RepairInstalledRuntime(context.Context, store.User, []byte) error {
	return errors.New("employee lifecycle is only available on Windows")
}

func (*WindowsPlatform) RenameInstalledAccount(context.Context, store.User, string, []byte) (string, error) {
	return "", errors.New("employee lifecycle is only available on Windows")
}

func (*WindowsPlatform) DeleteRetainedEmployee(context.Context, store.User) error {
	return errors.New("employee lifecycle is only available on Windows")
}
