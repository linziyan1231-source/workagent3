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
	"strings"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillmigration"
	"workagent3/internal/skillruntime"
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
	manifestPath := flags.String("manifest", "", "path to a credential-free migration inventory")
	runtimeDirectory := flags.String("runtime-dir", "", "stopped SID UserHost runtime directory")
	releaseRoot := flags.String("release-skills-root", "", "WorkAgent3 released builtin Skill root")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if !filepath.IsAbs(*manifestPath) || !filepath.IsAbs(*runtimeDirectory) || (*releaseRoot != "" && !filepath.IsAbs(*releaseRoot)) {
		return errors.New("manifest, runtime-dir, and optional release-skills-root must be absolute")
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
	migration, err := skillmigration.Open(filepath.Join(*runtimeDirectory, "skill-migration.db"), skills, releasedSkills(*releaseRoot))
	if err != nil {
		return err
	}
	defer migration.Close()
	ctx := context.Background()
	mcpResults, err := migration.MigrateMCP(ctx, manifest.MCPServers, mcp, credentialReadiness{store: credentials}, nil)
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
	results := append(mcpResults, skillResults...)
	return json.NewEncoder(output).Encode(struct {
		SID     string                  `json:"sid"`
		Results []skillmigration.Result `json:"results"`
	}{SID: manifest.SID, Results: results})
}

func releasedSkills(root string) map[string]string {
	result := map[string]string{}
	if root == "" {
		return result
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return result
	}
	for _, entry := range entries {
		if entry.IsDir() {
			path := filepath.Join(root, entry.Name())
			if info, err := os.Stat(filepath.Join(path, "SKILL.md")); err == nil && info.Mode().IsRegular() {
				result[strings.ToLower(entry.Name())] = path
			}
		}
	}
	return result
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
