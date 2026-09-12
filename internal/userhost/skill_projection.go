package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"

	"workagent3/internal/skillruntime"
)

type skillProjectionPublisher interface {
	Publish(context.Context) error
}

type harnessSkillProjectionPublisher struct {
	store  *skillruntime.Store
	target *url.URL
	token  string
	client *http.Client
}

type harnessSkillProjection struct {
	Skills           []harnessResolvedSkill `json:"skills"`
	NativeSkillPaths []string               `json:"nativeSkillPaths"`
}

type harnessResolvedSkill struct {
	Entry resolvedSkillEntry `json:"entry"`
	Root  string             `json:"root"`
}

type resolvedSkillEntry struct {
	skillruntime.Entry
	Health            string `json:"health"`
	UnavailableReason string `json:"unavailableReason,omitempty"`
}

type commandLookup func(string) (string, error)

func resolveSkillEntry(entry skillruntime.Entry, lookup commandLookup) resolvedSkillEntry {
	resolved := resolvedSkillEntry{Entry: entry, Health: "ready"}
	if entry.ReferenceDirectory != "" {
		if !entry.SourceAvailable {
			resolved.Health, resolved.UnavailableReason = "unavailable", "source_disabled_or_missing"
			return resolved
		}
		if _, err := os.Stat(filepath.Join(entry.ReferenceDirectory, "SKILL.md")); err != nil {
			resolved.Health, resolved.UnavailableReason = "unavailable", "source_missing"
			return resolved
		}
	}
	for _, command := range entry.RequiredCommands {
		if _, err := lookup(command); err != nil {
			resolved.Health = "unavailable"
			resolved.UnavailableReason = "command_not_found:" + command
			return resolved
		}
	}
	return resolved
}

func (p *harnessSkillProjectionPublisher) Publish(ctx context.Context) error {
	entries, err := p.store.List(ctx)
	if err != nil {
		return err
	}
	projection := harnessSkillProjection{Skills: make([]harnessResolvedSkill, 0, len(entries))}
	projection.NativeSkillPaths, err = p.store.NativeSkillPaths(ctx)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		projection.Skills = append(projection.Skills, harnessResolvedSkill{Entry: resolveSkillEntry(entry, exec.LookPath), Root: p.store.RootFor(entry)})
	}
	body, err := json.Marshal(projection)
	if err != nil {
		return err
	}
	endpoint := p.target.ResolveReference(&url.URL{Path: "/internal/skill-projection"})
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return fmt.Errorf("publish skill projection: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("publish skill projection: status %d: %s", response.StatusCode, message)
	}
	return nil
}
