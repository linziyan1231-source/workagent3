package userhost

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillruntime"
)

type capabilitySyncRow struct {
	Key              string    `json:"key"`
	Kind             string    `json:"kind"`
	Name             string    `json:"name"`
	ResourceID       string    `json:"resourceId,omitempty"`
	Status           string    `json:"status"`
	Reason           string    `json:"reason,omitempty"`
	Stamp            string    `json:"stamp,omitempty"`
	CatalogUpdatedAt time.Time `json:"catalogUpdatedAt,omitempty"`
}
type capabilitySync struct {
	mu        sync.Mutex
	dataRoot  string
	imports   *capabilityImporter
	rows      map[string]capabilitySyncRow
	checkedAt time.Time
	problem   string
}

func newCapabilitySync(dataRoot string, imports *capabilityImporter) (*capabilitySync, error) {
	service := &capabilitySync{dataRoot: dataRoot, imports: imports, rows: map[string]capabilitySyncRow{}}
	data, err := os.ReadFile(service.path())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &service.rows); err != nil {
			return nil, errors.New("capability_sync_state_invalid")
		}
	}
	return service, nil
}
func (s *capabilitySync) path() string {
	return filepath.Join(s.dataRoot, "runtime", "capability-sync.json")
}

func sameGlobalMCP(ctx context.Context, input importedMCP, server mcpruntime.Server, credentials runtimeCredentialCatalog) bool {
	kind := input.Type
	if kind == "" {
		kind = "http"
		if input.Command != "" {
			kind = "stdio"
		}
	}
	if kind == "streamable-http" || kind == "streamablehttp" {
		kind = "http"
	}
	if kind != server.Transport.Kind {
		return false
	}
	if input.Command != server.Transport.Command || input.URL != server.Transport.URL || !reflect.DeepEqual(input.Args, server.Transport.Args) {
		return false
	}
	for _, pair := range []struct {
		values map[string]string
		ids    map[string]string
	}{{input.Env, server.Transport.EnvironmentCredentialIDs}, {input.Headers, server.Transport.HeaderCredentialIDs}} {
		if len(pair.values) != len(pair.ids) {
			return false
		}
		for key, value := range pair.values {
			secret, err := credentials.ResolveMCPValue(ctx, pair.ids[key])
			equal := err == nil && string(secret) == value
			clear(secret)
			if !equal {
				return false
			}
		}
	}
	return true
}

func (s *capabilitySync) run(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	discovered, err := discoverGlobalCapabilities(s.dataRoot)
	s.checkedAt = time.Now().UTC()
	if err != nil {
		s.problem = err.Error()
		return err
	}
	s.problem = ""
	seen := map[string]bool{}
	existingSkills, err := s.imports.skills.List(ctx)
	if err != nil {
		return err
	}
	sourceIDs := map[string]string{}
	for _, entry := range existingSkills {
		if entry.ReferenceDirectory != "" {
			resolved, err := filepath.EvalSymlinks(entry.ReferenceDirectory)
			if err == nil {
				sourceIDs[resolved] = entry.ID
			}
		}
	}
	for _, item := range discovered {
		if item.Kind == "skill" {
			resolved, err := filepath.EvalSymlinks(item.Directory)
			if err != nil {
				item.Problem = "source_missing"
			} else if withinDirectory(filepath.Join(s.dataRoot, "workspace"), resolved) {
				continue
			} else if id, found := sourceIDs[resolved]; found && s.rows[item.Key].ResourceID != id {
				continue
			}
		}
		seen[item.Key] = true
		row := s.rows[item.Key]
		row.Key, row.Kind, row.Name = item.Key, item.Kind, item.Name
		if item.Problem != "" {
			row.Status, row.Reason = "unavailable", item.Problem
			s.rows[item.Key] = row
			continue
		}
		if row.Status == "removed" {
			s.rows[item.Key] = row
			continue
		}
		if item.Kind == "skill" {
			if row.ResourceID != "" {
				if _, err := s.imports.skills.Get(ctx, row.ResourceID); errors.Is(err, skillruntime.ErrNotFound) {
					row.Status = "removed"
					s.rows[item.Key] = row
					continue
				}
			}
			newReference := row.ResourceID == ""
			if newReference {
				id, err := auth.RandomToken(18)
				if err != nil {
					return err
				}
				row.ResourceID = "global-" + id
			}
			entry, err := s.imports.skills.Reference(ctx, skillruntime.Entry{ID: row.ResourceID, Name: item.Name, Description: item.Description, Version: item.Version, Enabled: item.Enabled, CompatibleEngines: item.CompatibleEngines}, item.Directory)
			if err != nil {
				row.Status, row.Reason = "conflict", "skill_reference_failed"
				if newReference {
					row.ResourceID = ""
				}
			} else {
				row.Status, row.Reason = "ready", ""
				if !entry.Enabled {
					row.Status = "disabled"
				}
				row.Stamp = item.Stamp
				resolved, _ := filepath.EvalSymlinks(item.Directory)
				sourceIDs[resolved] = entry.ID
			}
		} else if item.Kind == "mcp" {
			var existing *mcpruntime.Server
			if row.ResourceID != "" {
				server, err := s.imports.mcp.Get(ctx, row.ResourceID)
				if errors.Is(err, mcpruntime.ErrNotFound) {
					row.Status = "removed"
					s.rows[item.Key] = row
					continue
				}
				if err != nil {
					return err
				}
				existing = &server
				if sameGlobalMCP(ctx, item.MCP, server, s.imports.credentials) {
					if row.Stamp == "" && server.Health == "unavailable" {
						server.Health = "unknown"
						updated, err := s.imports.mcp.Replace(ctx, server)
						if err != nil {
							return err
						}
						if row.CatalogUpdatedAt.Equal(server.UpdatedAt) {
							row.CatalogUpdatedAt = updated.UpdatedAt
						}
					}
					row.Stamp = item.Stamp
				}
				if row.Stamp == item.Stamp {
					row.Status, row.Reason = "ready", ""
					if !server.Enabled {
						row.Status = "disabled"
					}
					s.rows[item.Key] = row
					continue
				}
				if !row.CatalogUpdatedAt.Equal(server.UpdatedAt) {
					row.Status, row.Reason = "conflict", "source_and_settings_changed"
					s.rows[item.Key] = row
					continue
				}
			}
			id, err := s.imports.importMCPRecord(ctx, item.Name, item.MCP, existing)
			if err != nil {
				row.Status, row.Reason = "conflict", "mcp_registration_failed"
			} else {
				row.ResourceID, row.Stamp, row.Status, row.Reason = id, item.Stamp, "ready", ""
				server, err := s.imports.mcp.Get(ctx, id)
				if err != nil {
					return err
				}
				if existing == nil && !item.Enabled {
					server.Enabled = false
					server, err = s.imports.mcp.Replace(ctx, server)
					if err != nil {
						return err
					}
				}
				row.CatalogUpdatedAt = server.UpdatedAt
				if !server.Enabled {
					row.Status = "disabled"
				}
			}
		}
		s.rows[item.Key] = row
	}
	for key, row := range s.rows {
		if seen[key] || row.Status == "removed" {
			continue
		}
		row.Status, row.Reason = "unavailable", "source_missing"
		row.Stamp = ""
		if row.Kind == "mcp" && row.ResourceID != "" {
			server, err := s.imports.mcp.Get(ctx, row.ResourceID)
			if err == nil && server.Health != "unavailable" {
				ownedUpdate := row.CatalogUpdatedAt.Equal(server.UpdatedAt)
				server.Health = "unavailable"
				server, err = s.imports.mcp.Replace(ctx, server)
				if err != nil {
					return err
				}
				if ownedUpdate {
					row.CatalogUpdatedAt = server.UpdatedAt
				}
			}
		}
		s.rows[key] = row
	}
	for key, row := range s.rows {
		if row.Kind == "mcp" && row.Status == "unavailable" && row.ResourceID != "" {
			row.Stamp = ""
			server, err := s.imports.mcp.Get(ctx, row.ResourceID)
			if err == nil && server.Health != "unavailable" {
				ownedUpdate := row.CatalogUpdatedAt.Equal(server.UpdatedAt)
				server.Health = "unavailable"
				server, err = s.imports.mcp.Replace(ctx, server)
				if err != nil {
					return err
				}
				if ownedUpdate {
					row.CatalogUpdatedAt = server.UpdatedAt
				}
			}
			s.rows[key] = row
		}
		if row.Kind != "skill" || row.ResourceID == "" {
			continue
		}
		if err := s.imports.skills.SetSourceAvailable(ctx, row.ResourceID, row.Status == "ready" || row.Status == "disabled"); err != nil {
			return err
		}
		link := filepath.Join(s.dataRoot, ".agents", "skills", "wa3-"+row.ResourceID)
		if row.Status == "ready" {
			entry, err := s.imports.skills.Get(ctx, row.ResourceID)
			if err == nil {
				err = skillruntime.EnsureDirectoryReference(link, entry.ReferenceDirectory)
			}
			if err != nil {
				row.Status, row.Reason = "conflict", "shared_directory_reference_failed"
				s.rows[key] = row
			}
		} else if err := skillruntime.RemoveDirectoryReference(link); err != nil {
			row.Reason = "shared_directory_reference_conflict"
			s.rows[key] = row
		}
	}
	data, err := json.Marshal(s.rows)
	if err != nil {
		return err
	}
	temporary := s.path() + ".tmp"
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.path()); err != nil {
		return err
	}
	if err := s.reconcileKimiSkills(ctx); err != nil {
		s.problem = "kimi_skill_configuration_failed"
	}
	if err := s.imports.mcpPublisher.Publish(ctx); err != nil {
		return err
	}
	return s.imports.skillPublisher.Publish(ctx)
}

func (s *capabilitySync) status(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := make([]capabilitySyncRow, 0, len(s.rows))
	for _, row := range s.rows {
		rows = append(rows, row)
	}
	writeRuntimeJSON(w, http.StatusOK, map[string]any{"checkedAt": s.checkedAt, "error": s.problem, "items": rows, "scope": "employee-global", "appliesTo": "new-sessions"})
}
func (s *capabilitySync) syncNow(w http.ResponseWriter, r *http.Request) {
	if err := s.run(r.Context()); err != nil {
		writeRuntimeError(w, 500, "capability_sync_failed")
		return
	}
	s.status(w, r)
}
func (s *capabilitySync) watch(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = s.run(ctx)
		}
	}
}
