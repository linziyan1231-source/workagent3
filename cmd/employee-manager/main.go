package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workagent3/internal/employee"
	"workagent3/internal/employeemanager"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

type managerConfig struct {
	DatabasePath         string              `json:"databasePath"`
	DataRootBase         string              `json:"dataRootBase"`
	UserHostExecutable   string              `json:"userHostExecutable"`
	HarnessCommand       string              `json:"harnessCommand"`
	HarnessEntrypoint    string              `json:"harnessEntrypoint"`
	CodexCommand         string              `json:"codexCommand,omitempty"`
	KimiCommand          string              `json:"kimiCommand,omitempty"`
	HarnessArguments     []string            `json:"harnessArguments,omitempty"`
	Profile              string              `json:"profile"`
	HarnessProfileSource string              `json:"harnessProfileSource"`
	ManagedSkillsRoot    string              `json:"managedSkillsRoot"`
	ManagedMCPServers    []mcpruntime.Server `json:"managedMcpServers,omitempty"`
	PortalURL            string              `json:"portalUrl"`
	Limits               winutil.JobLimits   `json:"limits"`
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configPath := flag.String("config", "", "absolute Employee Manager configuration path")
	action := flag.String("action", "add", "employee lifecycle action: add, enable, disable, reset-password, repair, rename-windows, set-limits, offboard-retain, offboard-delete, grant-admin, or revoke-admin")
	username := flag.String("username", "", "Windows and Portal username")
	newWindowsUsername := flag.String("new-windows-username", "", "new local Windows username for rename-windows")
	deleteConfirmation := flag.String("confirm-delete", "", "exact DELETE <username> confirmation for offboard-delete")
	memoryBytes := flag.Uint64("memory-bytes", 0, "Job Object memory limit for set-limits")
	cpuPercent := flag.Uint("cpu-percent", 0, "Job Object CPU percent for set-limits")
	activeProcesses := flag.Uint("active-processes", 0, "Job Object process limit for set-limits")
	listen := flag.String("listen", "", "serve the protected Employee Manager API on a 127.0.0.1 address")
	tokenFile := flag.String("token-file", "", "absolute path to the protected Employee Manager API token")
	flag.Parse()
	if !filepath.IsAbs(*configPath) || (*listen == "" && *username == "") {
		return errors.New("absolute --config and either --username or --listen are required")
	}
	config, err := loadManagerConfig(*configPath)
	if err != nil {
		return err
	}
	var password []byte
	if *listen == "" && (*action == "add" || *action == "reset-password" || *action == "repair" || *action == "rename-windows") {
		password, err = io.ReadAll(io.LimitReader(os.Stdin, 257))
		if err != nil {
			return fmt.Errorf("read Portal password: %w", err)
		}
		defer zero(password)
		password = bytesTrimLineEnding(password)
	}
	data, err := store.Open(config.DatabasePath)
	if err != nil {
		return err
	}
	defer data.Close()
	platform, err := employee.NewWindowsPlatform(employee.WindowsPlatformConfig{
		DataRootBase: config.DataRootBase, UserHostExecutable: config.UserHostExecutable,
		HarnessCommand: config.HarnessCommand, HarnessEntrypoint: config.HarnessEntrypoint,
		CodexCommand: config.CodexCommand,
		KimiCommand:  config.KimiCommand, HarnessArguments: config.HarnessArguments,
		Profile: config.Profile, HarnessProfileSource: config.HarnessProfileSource,
		ManagedSkillsRoot: config.ManagedSkillsRoot,
		ManagedMCPServers: config.ManagedMCPServers,
		PortalURL:         config.PortalURL, Limits: config.Limits,
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	provisioner := employee.Provisioner{Platform: platform, Users: data, Runtimes: data, Secrets: employee.RandomSecrets{}}
	lifecycle := employee.Lifecycle{Platform: platform, Users: data}
	if *listen != "" {
		return serveManager(ctx, *listen, *tokenFile, &employeemanager.Service{Provisioner: &provisioner, Lifecycle: lifecycle, Users: data})
	}
	var user store.User
	switch *action {
	case "add":
		user, err = provisioner.Add(ctx, *username, password)
	case "enable", "disable":
		user, err = lifecycle.SetEnabled(ctx, *username, *action == "enable")
	case "reset-password":
		err = (employee.Lifecycle{Users: data}).ResetPortalPassword(ctx, *username, password)
		if err == nil {
			user, err = data.UserByUsername(ctx, *username)
		}
	case "set-limits":
		limits := winutil.JobLimits{MemoryBytes: *memoryBytes, CPUPercent: uint32(*cpuPercent), ActiveProcesses: uint32(*activeProcesses)}
		user, err = lifecycle.SetLimits(ctx, *username, limits)
	case "offboard-retain":
		user, err = lifecycle.OffboardRetain(ctx, *username)
	case "repair":
		user, err = lifecycle.Repair(ctx, *username, password)
	case "rename-windows":
		user, err = lifecycle.RenameWindowsAccount(ctx, *username, *newWindowsUsername, password)
	case "offboard-delete":
		err = lifecycle.DeleteRetainedEmployee(ctx, *username, *deleteConfirmation)
		user = store.User{Username: *username, Disabled: true, Offboarded: true}
	case "grant-admin", "revoke-admin":
		user, err = (employee.Lifecycle{Users: data}).SetPortalAdmin(ctx, *username, *action == "grant-admin")
	default:
		return errors.New("unsupported employee lifecycle action")
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"action": *action, "id": user.ID, "username": user.Username, "enabled": !user.Disabled, "admin": user.Admin})
}

func serveManager(ctx context.Context, address, tokenPath string, service *employeemanager.Service) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		return errors.New("Employee Manager must listen on an exact 127.0.0.1 address")
	}
	if !filepath.IsAbs(tokenPath) {
		return errors.New("absolute --token-file is required in service mode")
	}
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		return fmt.Errorf("read Employee Manager token: %w", err)
	}
	secret := strings.TrimSpace(string(token))
	zero(token)
	if secret == "" {
		return errors.New("Employee Manager token is empty")
	}
	server := &http.Server{Addr: address, Handler: employeemanager.Handler(service, secret), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 2 * time.Minute}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func loadManagerConfig(path string) (managerConfig, error) {
	file, err := os.Open(path)
	if err != nil {
		return managerConfig{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024))
	decoder.DisallowUnknownFields()
	var config managerConfig
	if err := decoder.Decode(&config); err != nil {
		return managerConfig{}, fmt.Errorf("decode Employee Manager configuration: %w", err)
	}
	for _, path := range []string{config.DatabasePath, config.DataRootBase, config.UserHostExecutable, config.HarnessCommand, config.HarnessProfileSource, config.ManagedSkillsRoot} {
		if !filepath.IsAbs(path) {
			return managerConfig{}, errors.New("Employee Manager paths must be absolute")
		}
	}
	if strings.TrimSpace(config.Profile) == "" || strings.TrimSpace(config.PortalURL) == "" {
		return managerConfig{}, errors.New("Harness profile and Portal URL are required")
	}
	return config, nil
}

func bytesTrimLineEnding(value []byte) []byte {
	for len(value) > 0 && (value[len(value)-1] == '\r' || value[len(value)-1] == '\n') {
		value = value[:len(value)-1]
	}
	return value
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
