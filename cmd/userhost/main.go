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
	"time"

	"workagent3/internal/userhost"
	"workagent3/internal/winutil"
)

type fileConfig struct {
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

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configPath := flag.String("config", "", "absolute path to the UserHost configuration")
	flag.Parse()
	if !filepath.IsAbs(*configPath) {
		return errors.New("an absolute --config path is required")
	}
	config, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	credentialBytes, err := os.ReadFile(config.RegistrationCredentialFile)
	if err != nil {
		return fmt.Errorf("read runtime registration credential: %w", err)
	}
	defer zero(credentialBytes)
	credential := strings.TrimSpace(string(credentialBytes))
	reporter, err := userhost.NewHTTPLeaseReporter(config.PortalURL, credential)
	if err != nil {
		return err
	}
	supervisor, err := userhost.New(userhost.Config{
		SID: config.SID, DataRoot: config.DataRoot, Command: config.HarnessCommand,
		CodexCommand: config.CodexCommand, KimiCommand: config.KimiCommand,
		Arguments: config.HarnessArguments, Profile: config.Profile, Limits: config.Limits,
		StartupTimeout: time.Duration(config.StartupTimeoutSeconds) * time.Second,
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = supervisor.Serve(ctx, reporter)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func loadConfig(path string) (fileConfig, error) {
	file, err := os.Open(path)
	if err != nil {
		return fileConfig{}, fmt.Errorf("open UserHost configuration: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024))
	decoder.DisallowUnknownFields()
	var config fileConfig
	if err := decoder.Decode(&config); err != nil {
		return fileConfig{}, fmt.Errorf("decode UserHost configuration: %w", err)
	}
	if !filepath.IsAbs(config.DataRoot) || !filepath.IsAbs(config.HarnessCommand) || !filepath.IsAbs(config.RegistrationCredentialFile) {
		return fileConfig{}, errors.New("data root, Harness command, and registration credential file must be absolute")
	}
	return config, nil
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
