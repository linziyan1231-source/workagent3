package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/managedskills"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillmigration"
	"workagent3/internal/skillruntime"
	"workagent3/internal/userhost"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(arguments []string, output io.Writer) error {
	flags := flag.NewFlagSet("skill-migrate", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	action := flags.String("action", "migrate", "inventory or migrate")
	manifestPath := flags.String("manifest", "", "path to a credential-free migration inventory")
	legacyDatabase := flags.String("legacy-db", "", "read-only WorkAgent2/AionUi SQLite database")
	inventorySID := flags.String("sid", "", "employee SID recorded in an inventory")
	inventoryOutput := flags.String("output", "", "new credential-free inventory JSON path")
	assistantResources := flags.String("assistant-resources", "", "latest WorkAgent2 builtin assistant resource root")
	assistantLocale := flags.String("assistant-locale", "zh-CN", "locale used for builtin assistant rules")
	runtimeDirectory := flags.String("runtime-dir", "", "stopped SID UserHost runtime directory")
	dshHome := flags.String("dsh-home", "", "stopped SID Harness DSH_HOME for staged Preset migration")
	releaseRoot := flags.String("release-skills-root", "", "WorkAgent3 released builtin Skill root")
	userHostConfig := flags.String("userhost-config", "", "stopped SID UserHost configuration containing managed MCP definitions")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if *action == "inventory" {
		return captureInventory(*legacyDatabase, *inventorySID, *inventoryOutput, *assistantResources, *assistantLocale, output)
	}
	if *action != "migrate" {
		return errors.New("action must be inventory or migrate")
	}
	if !filepath.IsAbs(*manifestPath) || !filepath.IsAbs(*runtimeDirectory) || (*dshHome != "" && !filepath.IsAbs(*dshHome)) || (*releaseRoot != "" && !filepath.IsAbs(*releaseRoot)) || (*userHostConfig != "" && !filepath.IsAbs(*userHostConfig)) {
		return errors.New("manifest, runtime-dir, and optional dsh-home/release-skills-root/userhost-config must be absolute")
	}
	manifestFile, err := os.Open(*manifestPath)
	if err != nil {
		return fmt.Errorf("open migration manifest: %w", err)
	}
	defer manifestFile.Close()
	var manifest skillmigration.Manifest
	decoder := json.NewDecoder(io.LimitReader(manifestFile, 16<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return fmt.Errorf("decode migration manifest: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("migration manifest must contain one JSON document")
	}
	if err := os.MkdirAll(*runtimeDirectory, 0o700); err != nil {
		return fmt.Errorf("create runtime directory: %w", err)
	}
	skills, err := skillruntime.Open(filepath.Join(*runtimeDirectory, "skill-catalog.db"), filepath.Join(*runtimeDirectory, "skills"))
	if err != nil {
		return err
	}
	defer skills.Close()
	mcp, err := mcpruntime.Open(filepath.Join(*runtimeDirectory, "mcp-catalog.db"))
	if err != nil {
		return err
	}
	defer mcp.Close()
	credentials, err := credentialbroker.Open(filepath.Join(*runtimeDirectory, "credential-broker.db"), credentialbroker.NewUserProtector())
	if err != nil {
		return err
	}
	defer credentials.Close()
	ctx := context.Background()
	managedReplacements := map[string]mcpruntime.Server(nil)
	if *userHostConfig != "" {
		config, err := userhost.LoadFileConfig(*userHostConfig)
		if err != nil {
			return err
		}
		if config.SID != manifest.SID {
			return errors.New("migration manifest and UserHost configuration SID do not match")
		}
		if config.ManagedMCPServers == nil {
			return errors.New("UserHost configuration has no managed MCP release")
		}
		if err := mcp.SyncManaged(ctx, config.ManagedMCPServers); err != nil {
			return err
		}
		managedReplacements = managedMCPReplacementIndex(config.ManagedMCPServers)
	}
	released := map[string]string{}
	if *releaseRoot != "" {
		if err := managedskills.Sync(ctx, *releaseRoot, skills); err != nil {
			return err
		}
		released, err = managedskills.ReleasedPaths(*releaseRoot)
		if err != nil {
			return err
		}
	}
	migration, err := skillmigration.Open(filepath.Join(*runtimeDirectory, "skill-migration.db"), skills, released)
	if err != nil {
		return err
	}
	defer migration.Close()
	mcpResults, err := migration.MigrateMCP(ctx, manifest.MCPServers, mcp, credentialReadiness{store: credentials}, managedReplacements)
	if err != nil {
		return err
	}
	mapping, err := migration.MCPMapping(ctx)
	if err != nil {
		return err
	}
	remappedSkills, err := skillmigration.RemapSkillDependencies(manifest.Skills, mapping)
	if err != nil {
		return err
	}
	manifest.Skills = remappedSkills
	skillResults, err := migration.Migrate(ctx, manifest, catalogReadiness{catalog: mcp})
	if err != nil {
		return err
	}
	presetProjection, presetResults, err := skillmigration.ProjectPresets(manifest, skillResults, mcpResults)
	if err != nil {
		return err
	}
	if len(presetProjection.Presets) != 0 {
		if *dshHome == "" {
			for index := range presetResults {
				presetResults[index].Status = skillmigration.NeedsReview
				presetResults[index].Reason = "preset_ingress_not_configured"
			}
		} else {
			if err := stagePresetProjection(*dshHome, presetProjection); err != nil {
				return err
			}
			for index := range presetResults {
				if presetResults[index].Status == skillmigration.Ready {
					presetResults[index].Status = skillmigration.NeedsReview
					presetResults[index].Reason = "preset_runtime_import_pending"
				}
			}
		}
	}
	results := append(append(append(append([]skillmigration.Result{}, manifest.Results...), mcpResults...), skillResults...), presetResults...)
	return json.NewEncoder(output).Encode(struct {
		SID     string                  `json:"sid"`
		Results []skillmigration.Result `json:"results"`
	}{SID: manifest.SID, Results: results})
}

func managedMCPReplacementIndex(servers []mcpruntime.Server) map[string]mcpruntime.Server {
	index := make(map[string]mcpruntime.Server, len(servers)*2)
	for _, server := range servers {
		index[server.ID] = server
		index[strings.ToLower(strings.TrimSpace(server.Name))] = server
	}
	return index
}

func stagePresetProjection(dshHome string, projection skillmigration.PresetProjection) error {
	directory := filepath.Join(dshHome, "workagent")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create Preset migration ingress: %w", err)
	}
	payload, err := json.MarshalIndent(projection, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	path := filepath.Join(directory, "preset-migration.json")
	if existing, readErr := os.ReadFile(path); readErr == nil {
		if bytes.Equal(existing, payload) {
			return nil
		}
		return errors.New("different Preset migration ingress already exists")
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create Preset migration ingress: %w", err)
	}
	if _, err := file.Write(payload); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func captureInventory(databasePath, sid, outputPath, assistantResources, assistantLocale string, output io.Writer) error {
	if !filepath.IsAbs(databasePath) || !filepath.IsAbs(outputPath) || (assistantResources != "" && !filepath.IsAbs(assistantResources)) {
		return errors.New("legacy-db, output, and optional assistant-resources must be absolute")
	}
	manifest, err := skillmigration.CaptureLegacyInventoryWithAssistantResources(context.Background(), databasePath, sid, time.Now(), skillmigration.AssistantResourceOptions{
		Root: assistantResources, Locale: assistantLocale, PublicBaseURL: "/assets/puxin-builtin-assistants",
	})
	if err != nil {
		return err
	}
	payload, err := manifest.Marshal()
	if err != nil {
		return err
	}
	file, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create migration inventory: %w", err)
	}
	if _, err := file.Write(append(payload, '\n')); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"sid": manifest.SID, "skills": len(manifest.Skills), "mcpServers": len(manifest.MCPServers), "skillBindings": len(manifest.SkillBindings), "mcpBindings": len(manifest.MCPBindings), "presets": len(manifest.Presets), "preclassifiedResults": len(manifest.Results)})
}

type catalogReadiness struct{ catalog *mcpruntime.Catalog }

func (r catalogReadiness) MigrationStatus(ctx context.Context, ids []string) (skillmigration.Status, string) {
	for _, id := range ids {
		server, err := r.catalog.Get(ctx, id)
		if err == nil && server.OAuthState == "needs_auth" {
			return skillmigration.NeedsAuth, "mcp_needs_auth:" + id
		}
		if err != nil || !server.Enabled || server.Health == "unavailable" || server.Health == "needs_review" || server.Health == "unknown" {
			return skillmigration.NeedsReview, "mcp_not_healthy:" + id
		}
	}
	return skillmigration.Ready, ""
}

type credentialReadiness struct{ store *credentialbroker.Store }

func (r credentialReadiness) CredentialReady(ctx context.Context, id string) bool {
	metadata, err := r.store.Metadata(ctx, id)
	return err == nil && metadata.State == credentialbroker.StateReady
}
