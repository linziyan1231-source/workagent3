package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workagent3/internal/userhost"
)

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
	config, err := userhost.LoadFileConfig(*configPath)
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

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
