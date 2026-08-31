//go:build !windows

package employee

import (
	"context"
	"errors"

	"workagent3/internal/store"
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
type WindowsPlatform struct{}

func NewWindowsPlatform(WindowsPlatformConfig) (*WindowsPlatform, error) {
	return nil, errors.New("employee provisioning is only available on Windows")
}

func (*WindowsPlatform) EnsureAccount(context.Context, string, []byte) (Account, error) {
	return Account{}, errors.New("employee provisioning is only available on Windows")
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
