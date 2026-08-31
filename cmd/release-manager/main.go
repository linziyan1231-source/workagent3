package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"workagent3/internal/notifications"
	"workagent3/internal/operations"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	action := flag.String("action", "status", "manifest, install, notify, readiness, activate, rollback, or status")
	databasePath := flag.String("db", filepath.Join("data", "operations.db"), "Operations/Release SQLite path")
	releaseRoot := flag.String("release-root", filepath.Join("data", "releases"), "Immutable release root")
	version := flag.String("version", "", "Release version")
	manifestPath := flag.String("manifest", "", "Release manifest path for install")
	sourceRoot := flag.String("source", "", "Release artifact source root for install")
	notificationsPath := flag.String("notifications-db", filepath.Join("data", "notifications.db"), "Notifications SQLite path")
	activationID := flag.Int64("activation-id", 0, "Activation journal ID for rollback")
	harnessEvidence := flag.String("harness-evidence", "", "Redacted successful Harness request evidence")
	codexEvidence := flag.String("codex-evidence", "", "Redacted successful Codex request evidence")
	kimiEvidence := flag.String("kimi-evidence", "", "Redacted successful Kimi request evidence")
	providerEvidence := flag.String("provider-evidence", "", "Redacted successful managed Provider request evidence")
	var componentFlags repeatedFlag
	flag.Var(&componentFlags, "component", "Release component=relative artifact path; repeat when building a manifest")
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
		if *version == "" {
			return errors.New("readiness requires -version")
		}
		readiness := operations.Readiness{
			CheckedAt:       now,
			Harness:         operations.Probe{OK: *harnessEvidence != "", Evidence: *harnessEvidence},
			Codex:           operations.Probe{OK: *codexEvidence != "", Evidence: *codexEvidence},
			Kimi:            operations.Probe{OK: *kimiEvidence != "", Evidence: *kimiEvidence},
			ManagedProvider: operations.Probe{OK: *providerEvidence != "", Evidence: *providerEvidence},
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

func (values *repeatedFlag) String() string { return strings.Join(*values, ",") }
func (values *repeatedFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func parseComponents(values []string) (map[operations.Component]string, error) {
	components := make(map[operations.Component]string, len(values))
	for _, value := range values {
		parts := strings.SplitN(value, "=", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, fmt.Errorf("invalid component artifact %q", value)
		}
		component := operations.Component(parts[0])
		if _, exists := components[component]; exists {
			return nil, fmt.Errorf("duplicate component artifact %q", component)
		}
		components[component] = filepath.ToSlash(parts[1])
	}
	return components, nil
}
