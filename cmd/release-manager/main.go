package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/modelgateway"
	"workagent3/internal/notifications"
	"workagent3/internal/operations"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() (err error) {
	action := flag.String("action", "status", "manifest, install, notify, readiness, activate, rollback, or status")
	databasePath := flag.String("db", filepath.Join("data", "operations.db"), "Operations/Release SQLite path")
	releaseRoot := flag.String("release-root", filepath.Join("data", "releases"), "Immutable release root")
	version := flag.String("version", "", "Release version")
	manifestPath := flag.String("manifest", "", "Release manifest path for install")
	sourceRoot := flag.String("source", "", "Release artifact source root for install")
	notificationsPath := flag.String("notifications-db", filepath.Join("data", "notifications.db"), "Notifications SQLite path")
	auditPath := flag.String("audit-db", filepath.Join("data", "audit.db"), "Audit SQLite path")
	activationID := flag.Int64("activation-id", 0, "Activation journal ID for rollback")
	gatewayConfigPath := flag.String("gateway-config", "", "Employee Manager configuration JSON whose modelGateway section the real readiness probes use")
	var componentFlags repeatedFlag
	flag.Var(&componentFlags, "component", "Release component=relative artifact path; repeat per artifact file when building a manifest")
	flag.Parse()

	root, err := filepath.Abs(*releaseRoot)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(*databasePath), 0o700); err != nil {
		return err
	}
	store, err := operations.Open(*databasePath, root)
	if err != nil {
		return err
	}
	defer store.Close()
	// Audit must never block a release operation; an unavailable audit
	// database is reported on stderr and recording is skipped.
	auditStore, auditErr := audit.Open(*auditPath)
	if auditErr != nil {
		fmt.Fprintf(os.Stderr, "audit unavailable: %v\n", auditErr)
	} else {
		defer auditStore.Close()
	}
	defer func() {
		auditAction, ok := map[string]string{
			"install": audit.ActionReleaseInstall, "notify": audit.ActionReleasePublish,
			"readiness": audit.ActionReleaseReadiness, "activate": audit.ActionReleaseActivate,
			"rollback": audit.ActionReleaseRollback,
		}[*action]
		if !ok || auditStore == nil {
			return
		}
		audit.RecordCLI(context.Background(), auditStore, "release-manager", auditAction, *version, err, map[string]string{
			"version": *version, "activation_id": strconv.FormatInt(*activationID, 10),
		})
	}()
	ctx := context.Background()
	now := time.Now().UTC()
	var output any
	switch *action {
	case "manifest":
		if *version == "" || *sourceRoot == "" {
			return errors.New("manifest requires -version and -source")
		}
		source, err := filepath.Abs(*sourceRoot)
		if err != nil {
			return err
		}
		components, err := parseComponents(componentFlags)
		if err != nil {
			return err
		}
		manifest, err := operations.BuildReleaseManifest(source, *version, components)
		if err != nil {
			return err
		}
		outputPath := *manifestPath
		if outputPath == "" {
			outputPath = filepath.Join(source, operations.ManifestName)
		} else if !filepath.IsAbs(outputPath) {
			return errors.New("manifest output path must be absolute")
		}
		if err := operations.WriteReleaseManifest(outputPath, manifest); err != nil {
			return err
		}
		output = manifest
	case "install":
		if *manifestPath == "" || *sourceRoot == "" {
			return errors.New("install requires -manifest and -source")
		}
		manifest, err := operations.ReadManifest(*manifestPath)
		if err != nil {
			return err
		}
		source, err := filepath.Abs(*sourceRoot)
		if err != nil {
			return err
		}
		output, err = store.Install(ctx, source, manifest, now)
		if err != nil {
			return err
		}
	case "notify":
		if *version == "" {
			return errors.New("notify requires -version")
		}
		if err := os.MkdirAll(filepath.Dir(*notificationsPath), 0o700); err != nil {
			return err
		}
		publisher, err := notifications.Open(*notificationsPath)
		if err != nil {
			return err
		}
		defer publisher.Close()
		output, err = store.PublishUpgrade(ctx, *version, publisher, now)
		if err != nil {
			return err
		}
	case "readiness":
		if *version == "" || *gatewayConfigPath == "" {
			return errors.New("readiness requires -version and -gateway-config")
		}
		gateway, err := loadGatewayConfig(*gatewayConfigPath)
		if err != nil {
			return err
		}
		client, err := modelgateway.NewCLIProxy(*gateway)
		if err != nil {
			return err
		}
		runID, err := auth.RandomToken(18)
		if err != nil {
			return err
		}
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()
		outcomes := client.RunReadinessProbes(probeCtx, *version, runID)
		readiness := operations.Readiness{CheckedAt: now}
		var failed []string
		for _, outcome := range outcomes {
			probe := operations.Probe{OK: outcome.Err == nil, Evidence: outcome.Evidence}
			switch outcome.Evidence.Engine {
			case "cliproxy":
				readiness.CLIProxy = probe
			case "codex":
				readiness.Codex = probe
			case "kimi":
				readiness.Kimi = probe
			case "harness":
				readiness.Harness = probe
			}
			if outcome.Err != nil {
				failed = append(failed, outcome.Evidence.Engine+": "+outcome.Err.Error())
			}
		}
		if len(failed) > 0 {
			summary, _ := json.Marshal(readiness)
			fmt.Fprintf(os.Stderr, "release readiness probes failed: %s\n%s\n", strings.Join(failed, "; "), summary)
			return errors.New("release readiness probes failed")
		}
		if err := store.RecordReadiness(ctx, *version, readiness); err != nil {
			return err
		}
		output = readiness
	case "activate":
		if *version == "" {
			return errors.New("activate requires -version")
		}
		output, err = store.Activate(ctx, *version, now)
		if err != nil {
			return err
		}
	case "rollback":
		if *activationID <= 0 {
			return errors.New("rollback requires a positive -activation-id")
		}
		output, err = store.Rollback(ctx, *activationID, now)
		if err != nil {
			return err
		}
	case "status":
		if *version == "" {
			output, err = store.Active(ctx)
		} else {
			output, err = store.Status(ctx, *version)
		}
		if err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown action %q", *action)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(output)
}

type repeatedFlag []string

// loadGatewayConfig reads the Employee Manager configuration JSON and returns
// its modelGateway section; the readiness probes use the exact same gateway
// coordinates and management key as the running deployment.
func loadGatewayConfig(path string) (*modelgateway.Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open gateway configuration: %w", err)
	}
	defer file.Close()
	var config struct {
		ModelGateway *modelgateway.Config `json:"modelGateway"`
	}
	if err := json.NewDecoder(io.LimitReader(file, 64*1024)).Decode(&config); err != nil {
		return nil, fmt.Errorf("decode gateway configuration: %w", err)
	}
	if config.ModelGateway == nil {
		return nil, errors.New("gateway configuration has no modelGateway section")
	}
	return config.ModelGateway, nil
}

func (values *repeatedFlag) String() string { return strings.Join(*values, ",") }
func (values *repeatedFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func parseComponents(values []string) (map[operations.Component][]string, error) {
	components := make(map[operations.Component][]string, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		parts := strings.SplitN(value, "=", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, fmt.Errorf("invalid component artifact %q", value)
		}
		if seen[value] {
			return nil, fmt.Errorf("duplicate component artifact %q", value)
		}
		seen[value] = true
		component := operations.Component(parts[0])
		components[component] = append(components[component], filepath.ToSlash(parts[1]))
	}
	return components, nil
}
