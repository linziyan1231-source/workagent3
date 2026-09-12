package main

import (
	"context"
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

	"workagent3/internal/publishedapps"
	"workagent3/internal/userhost"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if handled, err := publishedapps.Worker(os.Args[1:]); handled {
		return err
	}
	configPath := flag.String("config", "", "absolute path to the UserHost configuration")
	flag.Parse()
	if !filepath.IsAbs(*configPath) {
		return errors.New("an absolute --config path is required")
	}
	logFile, err := userhost.OpenRuntimeLog(filepath.Join(filepath.Dir(*configPath), "userhost.log"))
	if err != nil {
		return fmt.Errorf("open private UserHost log: %w", err)
	}
	// The process owns this file for its full lifetime. Do not close it before
	// main records a terminal error returned by run.
	log.SetOutput(io.MultiWriter(os.Stderr, logFile))
	config, err := userhost.LoadFileConfig(*configPath)
	if err != nil {
		return err
	}
	if err := userhost.ConfigureRuntimeStorage(config.DataRoot); err != nil {
		return err
	}
	if config.ManagedToolsRoot != "" {
		if err := os.Setenv("PATH", config.ManagedToolsRoot+string(os.PathListSeparator)+os.Getenv("PATH")); err != nil {
			return fmt.Errorf("configure managed tool path: %w", err)
		}
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
		PublishedPythonCommand: config.PublishedPythonCommand,
		CodexCommand:           config.CodexCommand, KimiCommand: config.KimiCommand,
		Arguments: config.HarnessArguments, Profile: config.Profile, Limits: config.Limits,
		StartupTimeout:          time.Duration(config.StartupTimeoutSeconds) * time.Second,
		ManagedSkillsRoot:       config.ManagedSkillsRoot,
		ManagedToolsRoot:        config.ManagedToolsRoot,
		ManagedMCPServers:       config.ManagedMCPServers,
		ProfessionalDatabaseURL: config.ProfessionalDatabaseURL,
		PublicBaseURL:           config.PublicBaseURL,
		PlatformURL:             config.PortalURL,
		PlatformCredential:      credential,
		HarnessModel:            config.HarnessModel, ModelGatewayBaseURL: config.ModelGatewayBaseURL,
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

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
