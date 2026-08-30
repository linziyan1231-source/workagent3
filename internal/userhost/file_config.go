package userhost

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"workagent3/internal/winutil"
)

type FileConfig struct {
	SID                        string            `json:"sid"`
	DataRoot                   string            `json:"dataRoot"`
	HarnessCommand             string            `json:"harnessCommand"`
	CodexCommand               string            `json:"codexCommand,omitempty"`
	KimiCommand                string            `json:"kimiCommand,omitempty"`
	HarnessArguments           []string          `json:"harnessArguments,omitempty"`
	Profile                    string            `json:"profile"`
	PortalURL                  string            `json:"portalUrl"`
	RegistrationCredentialFile string            `json:"registrationCredentialFile"`
	Limits                     winutil.JobLimits `json:"limits"`
	StartupTimeoutSeconds      int               `json:"startupTimeoutSeconds,omitempty"`
}

func LoadFileConfig(path string) (FileConfig, error) {
	file, err := os.Open(path)
	if err != nil {
		return FileConfig{}, fmt.Errorf("open UserHost configuration: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024))
	decoder.DisallowUnknownFields()
	var config FileConfig
	if err := decoder.Decode(&config); err != nil {
		return FileConfig{}, fmt.Errorf("decode UserHost configuration: %w", err)
	}
	if !filepath.IsAbs(config.DataRoot) || !filepath.IsAbs(config.HarnessCommand) || !filepath.IsAbs(config.RegistrationCredentialFile) {
		return FileConfig{}, errors.New("data root, Harness command, and registration credential file must be absolute")
	}
	return config, nil
}
