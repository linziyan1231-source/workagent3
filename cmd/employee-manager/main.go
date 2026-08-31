package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"workagent3/internal/employee"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

type managerConfig struct {
	DatabasePath         string            `json:"databasePath"`
	DataRootBase         string            `json:"dataRootBase"`
	UserHostExecutable   string            `json:"userHostExecutable"`
	HarnessCommand       string            `json:"harnessCommand"`
	HarnessEntrypoint    string            `json:"harnessEntrypoint"`
	CodexCommand         string            `json:"codexCommand,omitempty"`
	KimiCommand          string            `json:"kimiCommand,omitempty"`
	HarnessArguments     []string          `json:"harnessArguments,omitempty"`
	Profile              string            `json:"profile"`
	HarnessProfileSource string            `json:"harnessProfileSource"`
	PortalURL            string            `json:"portalUrl"`
	Limits               winutil.JobLimits `json:"limits"`
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configPath := flag.String("config", "", "absolute Employee Manager configuration path")
	username := flag.String("username", "", "Windows and Portal username to provision")
	flag.Parse()
	if !filepath.IsAbs(*configPath) || *username == "" {
		return errors.New("absolute --config and --username are required")
	}
	config, err := loadManagerConfig(*configPath)
	if err != nil {
		return err
	}
	password, err := io.ReadAll(io.LimitReader(os.Stdin, 257))
	if err != nil {
		return fmt.Errorf("read Portal password: %w", err)
	}
	defer zero(password)
	password = bytesTrimLineEnding(password)
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
		PortalURL: config.PortalURL, Limits: config.Limits,
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	provisioner := employee.Provisioner{Platform: platform, Users: data, Runtimes: data, Secrets: employee.RandomSecrets{}}
	user, err := provisioner.Add(ctx, *username, password)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"id": user.ID, "username": user.Username, "enabled": !user.Disabled})
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
	for _, path := range []string{config.DatabasePath, config.DataRootBase, config.UserHostExecutable, config.HarnessCommand, config.HarnessProfileSource} {
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
