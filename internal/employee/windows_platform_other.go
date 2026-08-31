//go:build !windows

package employee

import (
	"errors"

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
