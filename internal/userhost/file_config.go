package userhost

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"workagent3/internal/mcpruntime"
	"workagent3/internal/nativeauth"
	"workagent3/internal/winutil"
)

type FileConfig struct {
	PublicBaseURL              string              `json:"publicBaseURL,omitempty"`
	SID                        string              `json:"sid"`
	DataRoot                   string              `json:"dataRoot"`
	HarnessCommand             string              `json:"harnessCommand"`
	CodexCommand               string              `json:"codexCommand,omitempty"`
	KimiCommand                string              `json:"kimiCommand,omitempty"`
	HarnessArguments           []string            `json:"harnessArguments,omitempty"`
	Profile                    string              `json:"profile"`
	PortalURL                  string              `json:"portalUrl"`
	RegistrationCredentialFile string              `json:"registrationCredentialFile"`
	Limits                     winutil.JobLimits   `json:"limits"`
	StartupTimeoutSeconds      int                 `json:"startupTimeoutSeconds,omitempty"`
	ManagedSkillsRoot          string              `json:"managedSkillsRoot,omitempty"`
	ManagedToolsRoot           string              `json:"managedToolsRoot,omitempty"`
	ManagedMCPServers          []mcpruntime.Server `json:"managedMcpServers,omitempty"`
	ProfessionalDatabaseURL    string              `json:"professionalDatabaseUrl,omitempty"`
	// HarnessModel and ModelGatewayBaseURL come from the employee-manager
	// modelGateway configuration (docs/employee-manager.config.example.json);
	// both are empty only in deployments without a managed model gateway.
	HarnessModel        string `json:"harnessModel,omitempty"`
	ModelGatewayBaseURL string `json:"modelGatewayBaseUrl,omitempty"`
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
	if config.ManagedSkillsRoot != "" && !filepath.IsAbs(config.ManagedSkillsRoot) {
		return FileConfig{}, errors.New("managed skills root must be absolute")
	}
	if config.ManagedToolsRoot != "" && !filepath.IsAbs(config.ManagedToolsRoot) {
		return FileConfig{}, errors.New("managed tools root must be absolute")
	}
	if err := ValidateProfessionalDatabaseURL(config.ProfessionalDatabaseURL); err != nil {
		return FileConfig{}, err
	}
	if (config.HarnessModel == "") != (config.ModelGatewayBaseURL == "") {
		return FileConfig{}, errors.New("harness model and model gateway base URL must be configured together")
	}
	if config.ModelGatewayBaseURL != "" {
		if err := nativeauth.ValidateBaseURL(config.ModelGatewayBaseURL); err != nil {
			return FileConfig{}, err
		}
		if !nativeauth.ValidModel(config.HarnessModel) {
			return FileConfig{}, errors.New("harness model is invalid")
		}
	}
	return config, nil
}

// ValidateProfessionalDatabaseURL bounds the one employee-installed service
// whose connection check may reach loopback. Only deployment configuration
// supplies this address; an ordinary MCP URL never expands the allowance.
func ValidateProfessionalDatabaseURL(value string) error {
	if value == "" {
		return nil
	}
	endpoint, err := url.Parse(value)
	if err != nil {
		return errors.New("invalid professional database URL")
	}
	port, err := strconv.Atoi(endpoint.Port())
	if err != nil || port < 1 || port > 65535 || endpoint.Scheme != "http" || !net.ParseIP(endpoint.Hostname()).IsLoopback() || endpoint.Path != "/professional-database/mcp" || endpoint.RawPath != "" || endpoint.RawQuery != "" || endpoint.ForceQuery || strings.Contains(value, "#") || endpoint.User != nil {
		return errors.New("professional database URL must be an exact loopback HTTP endpoint ending in /professional-database/mcp without query, fragment or credentials")
	}
	return nil
}
