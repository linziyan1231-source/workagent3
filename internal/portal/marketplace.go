package portal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"workagent3/internal/auth"
	"workagent3/internal/marketplace"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/skillruntime"
	"workagent3/internal/store"
)

type marketRuntime struct{ endpoint runtimeapi.Endpoint }

func (m marketRuntime) call(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	response, err := m.send(ctx, method, path, body, nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if output != nil {
		return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output)
	}
	return nil
}
func (m marketRuntime) send(ctx context.Context, method, path string, body io.Reader, headers map[string]string) (*http.Response, error) {
	relative, err := url.Parse(path)
	if err != nil {
		return nil, err
	}
	target := m.endpoint.BaseURL.ResolveReference(relative)
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+m.endpoint.Token)
	request.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		request.Header.Set(k, v)
	}
	setCorrelationHeader(request)
	response, err := (&http.Client{Timeout: 2 * time.Minute}).Do(request)
	if err != nil {
		return nil, errors.New("market_runtime_unavailable")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return nil, fmt.Errorf("market_runtime_rejected_%d", response.StatusCode)
	}
	return response, nil
}
func (s *Server) marketCatalog(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil {
		writeError(w, 503, "market_unavailable")
		return
	}
	if r.Method == http.MethodDelete {
		err := s.modules.Marketplace.Unpublish(r.Context(), r.URL.Query().Get("id"), user.Username)
		if err != nil {
			marketError(w, err)
			return
		}
		s.recordBusinessEvent(r.Context(), user.SID, "market.unpublish", r.URL.Query().Get("id"), nil, nil)
		w.WriteHeader(204)
		return
	}
	if id := r.URL.Query().Get("id"); id != "" {
		e, b, err := s.modules.Marketplace.Get(r.Context(), id)
		if err != nil {
			marketError(w, err)
			return
		}
		for i := range b.Skills {
			b.Skills[i].Archive = nil
		}
		writeJSON(w, 200, map[string]any{"entry": e, "bundle": b})
		return
	}
	entries, err := s.modules.Marketplace.List(r.Context(), user.Username, user.SID)
	if err != nil {
		marketError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"entries": entries})
}
func marketError(w http.ResponseWriter, err error) {
	status := 400
	if errors.Is(err, marketplace.ErrNotFound) {
		status = 404
	}
	if errors.Is(err, marketplace.ErrForbidden) {
		status = 403
	}
	code := err.Error()
	if strings.Contains(code, "constraint") {
		code = "market_version_exists"
	}
	writeError(w, status, code)
}

type marketPublishInput struct {
	Kind        string `json:"kind"`
	SourceID    string `json:"sourceId"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

var marketVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

func (s *Server) publishMarketEntry(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil {
		writeError(w, 503, "market_unavailable")
		return
	}
	var input marketPublishInput
	if !decodeJSON(r, &input, 16*1024) || input.SourceID == "" || !marketVersion.MatchString(input.Version) || (input.Kind != "skill" && input.Kind != "mcp" && input.Kind != "assistant") {
		writeError(w, 400, "invalid_market_publish")
		return
	}
	endpoint, err := s.runtimes.Resolve(r.Context(), user.SID)
	if err != nil {
		writeError(w, 503, "runtime_unavailable")
		return
	}
	remote := marketRuntime{endpoint: endpoint}
	b, name, err := s.snapshotMarketBundle(r.Context(), remote, user, input)
	if err != nil {
		marketError(w, err)
		return
	}
	if input.Name == "" {
		input.Name = name
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		writeError(w, 500, "market_publish_failed")
		return
	}
	e := marketplace.Entry{ID: id, Kind: input.Kind, Name: input.Name, Description: input.Description, Version: input.Version, Publisher: user.Username}
	if err = s.modules.Marketplace.Publish(r.Context(), e, b); err != nil {
		marketError(w, err)
		return
	}
	s.recordBusinessEvent(r.Context(), user.SID, "market.publish", id, nil, map[string]string{"kind": input.Kind, "name": input.Name, "version": input.Version})
	writeJSON(w, 201, map[string]any{"entry": e})
}
func (s *Server) snapshotMarketBundle(ctx context.Context, remote marketRuntime, user store.User, input marketPublishInput) (marketplace.Bundle, string, error) {
	b := marketplace.Bundle{Skills: []marketplace.Skill{}, MCP: []marketplace.Connector{}}
	var skills []skillruntime.Entry
	var servers []mcpruntime.Server
	if err := remote.call(ctx, "GET", "/v1/skills", nil, &skills); err != nil {
		return b, "", err
	}
	if err := remote.call(ctx, "GET", "/v1/mcp-servers", nil, &servers); err != nil {
		return b, "", err
	}
	skillIDs := []string{}
	mcpIDs := []string{}
	name := ""
	switch input.Kind {
	case "skill":
		skillIDs = append(skillIDs, input.SourceID)
	case "mcp":
		mcpIDs = append(mcpIDs, input.SourceID)
	case "assistant":
		var presets []struct {
			marketplace.Assistant
			ID     string `json:"id"`
			Source string `json:"source"`
		}
		if err := remote.call(ctx, "GET", "/v1/presets", nil, &presets); err != nil {
			return b, "", err
		}
		for _, p := range presets {
			if p.ID == input.SourceID {
				if p.Source != "user" {
					return b, "", errors.New("market_publish_own_assistant_only")
				}
				a := p.Assistant
				b.Assistant = &a
				skillIDs = append(skillIDs, a.SkillIDs...)
				mcpIDs = append(mcpIDs, a.MCPServerIDs...)
				name = a.Name
				break
			}
		}
		if b.Assistant == nil {
			return b, "", errors.New("market_source_not_found")
		}
	}
	total := 0
	for _, id := range uniqueIDs(skillIDs) {
		var source *skillruntime.Entry
		for i := range skills {
			if skills[i].ID == id {
				source = &skills[i]
				break
			}
		}
		if source == nil {
			return b, "", errors.New("market_skill_dependency_missing")
		}
		if input.Kind == "skill" {
			name = source.Name
		}
		v := marketplace.Skill{ID: id, Name: source.Name, Description: source.Description, Version: source.Version, RequiredMCP: source.RequiredMCPServerIDs}
		switch source.Source {
		case "builtin", "managed":
			if input.Kind == "skill" {
				return b, "", errors.New("market_publish_own_skill_only")
			}
			v.Builtin = true
		case "user":
			response, err := remote.send(ctx, "GET", "/v1/skills/export?name="+url.QueryEscape(source.Name), nil, nil)
			if err != nil {
				return b, "", err
			}
			v.Archive, err = io.ReadAll(io.LimitReader(response.Body, (50<<20)+1))
			response.Body.Close()
			if err != nil {
				return b, "", err
			}
		case "market":
			old, err := s.modules.Marketplace.InstalledSkill(ctx, user.SID, id)
			if err == nil {
				v.Archive = old.Archive
				v.Builtin = old.Builtin
				v.RequiredMCP = uniqueIDs(append(v.RequiredMCP, old.RequiredMCP...))
			} else if s.modules.SkillMarket != nil {
				pack, e := s.modules.SkillMarket.ApprovedPackage(ctx, id)
				if e != nil {
					return b, "", errors.New("market_skill_snapshot_unavailable")
				}
				v.Archive = pack.Archive
			} else {
				return b, "", err
			}
		default:
			return b, "", errors.New("market_publish_own_skill_only")
		}
		total += len(v.Archive)
		if total > 50<<20 {
			return b, "", errors.New("market_bundle_too_large")
		}
		b.Skills = append(b.Skills, v)
		mcpIDs = append(mcpIDs, v.RequiredMCP...)
	}
	for _, id := range uniqueIDs(mcpIDs) {
		var source *mcpruntime.Server
		for i := range servers {
			if servers[i].ID == id {
				source = &servers[i]
				break
			}
		}
		if source == nil {
			return b, "", errors.New("market_mcp_dependency_missing")
		}
		if input.Kind == "mcp" {
			name = source.Name
		}
		v, err := portableConnector(*source)
		if err != nil {
			return b, "", err
		}
		b.MCP = append(b.MCP, v)
	}
	if b.Assistant != nil {
		b.Assistant.MCPServerIDs = uniqueIDs(mcpIDs)
	}
	return b, name, nil
}
func uniqueIDs(ids []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	return result
}
func portableConnector(source mcpruntime.Server) (marketplace.Connector, error) {
	if source.Source == "managed" {
		return marketplace.Connector{ID: source.ID, Name: source.Name, Builtin: true, CredentialNames: []string{}, AllowedTools: []string{}}, nil
	}
	v := marketplace.Connector{ID: source.ID, Name: source.Name, Description: source.Description, Transport: source.Transport, ToolPolicy: source.ToolPolicy, AllowedTools: source.AllowedTools, CredentialNames: []string{}, OAuth: source.OAuthState != "none"}
	if source.Transport.Kind == "stdio" && (filepath.IsAbs(source.Transport.Command) || strings.Contains(source.Transport.Command, ":\\")) {
		return v, errors.New("market_mcp_command_not_portable")
	}
	if source.Transport.URL != "" {
		u, err := url.Parse(source.Transport.URL)
		if err != nil || u.User != nil {
			return v, errors.New("market_mcp_url_contains_credentials")
		}
		for key := range u.Query() {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "token") || strings.Contains(lower, "key") || strings.Contains(lower, "secret") || strings.Contains(lower, "password") {
				return v, errors.New("market_mcp_url_contains_credentials")
			}
		}
	}
	for name := range source.Transport.EnvironmentCredentialIDs {
		v.CredentialNames = append(v.CredentialNames, name)
	}
	for name := range source.Transport.HeaderCredentialIDs {
		v.CredentialNames = append(v.CredentialNames, name)
	}
	sort.Strings(v.CredentialNames)
	v.Transport.EnvironmentCredentialIDs = map[string]string{}
	v.Transport.HeaderCredentialIDs = map[string]string{}
	return v, nil
}

func (s *Server) installMarketEntry(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil {
		writeError(w, 503, "market_unavailable")
		return
	}
	var input struct {
		ID          string                       `json:"id"`
		Credentials map[string]map[string]string `json:"credentials"`
	}
	if !decodeJSON(r, &input, 256*1024) || input.ID == "" {
		writeError(w, 400, "invalid_market_install")
		return
	}
	e, b, err := s.modules.Marketplace.Get(r.Context(), input.ID)
	if err != nil {
		marketError(w, err)
		return
	}
	endpoint, err := s.runtimes.Resolve(r.Context(), user.SID)
	if err != nil {
		writeError(w, 503, "runtime_unavailable")
		return
	}
	s.modules.Marketplace.InstallMu.Lock()
	defer s.modules.Marketplace.InstallMu.Unlock()
	installed, err := s.installBundle(r.Context(), marketRuntime{endpoint: endpoint}, user, e, b, input.Credentials)
	for _, slots := range input.Credentials {
		for key := range slots {
			delete(slots, key)
		}
	}
	s.recordBusinessEvent(r.Context(), user.SID, "market.install", e.ID, err, map[string]string{"kind": e.Kind})
	if err != nil {
		marketError(w, err)
		return
	}
	writeJSON(w, 201, map[string]any{"installation": installed})
}
func (s *Server) installBundle(ctx context.Context, remote marketRuntime, user store.User, e marketplace.Entry, b marketplace.Bundle, secrets map[string]map[string]string) (marketplace.Installation, error) {
	state, err := s.modules.Marketplace.Installation(ctx, user.SID, e.ID)
	if err != nil {
		return state, err
	}
	state.Complete = false
	var skills []skillruntime.Entry
	var servers []mcpruntime.Server
	var presets []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err = remote.call(ctx, "GET", "/v1/skills", nil, &skills); err != nil {
		return state, err
	}
	if err = remote.call(ctx, "GET", "/v1/mcp-servers", nil, &servers); err != nil {
		return state, err
	}
	if err = remote.call(ctx, "GET", "/v1/presets", nil, &presets); err != nil {
		return state, err
	}
	save := func() error { return s.modules.Marketplace.SaveInstallation(ctx, user.SID, e.ID, state) }
	suffix := " [" + e.ID[:8] + "]"
	for _, m := range b.MCP {
		target := ""
		for _, current := range servers {
			if (m.Builtin && (current.ID == m.ID || current.Name == m.Name)) || current.ID == state.MCP[m.ID] || current.Name == m.Name+suffix {
				target = current.ID
				break
			}
		}
		if target != "" {
			state.MCP[m.ID] = target
			continue
		}
		if m.Builtin {
			return state, errors.New("market_builtin_dependency_unavailable")
		}
		for _, name := range m.CredentialNames {
			if secrets[m.ID][name] == "" {
				return state, errors.New("market_credentials_required")
			}
		}
		transport := m.Transport
		transport.EnvironmentCredentialIDs = map[string]string{}
		transport.HeaderCredentialIDs = map[string]string{}
		for _, name := range m.CredentialNames {
			kind := "mcp_header"
			if transport.Kind == "stdio" {
				kind = "mcp_env"
			}
			var credential struct {
				ID string `json:"id"`
			}
			if err = remote.call(ctx, "POST", "/v1/credentials", map[string]any{"kind": kind, "label": m.Name + suffix + " " + name, "secret": secrets[m.ID][name]}, &credential); err != nil {
				return state, err
			}
			if transport.Kind == "stdio" {
				transport.EnvironmentCredentialIDs[name] = credential.ID
			} else {
				transport.HeaderCredentialIDs[name] = credential.ID
			}
		}
		var created mcpruntime.Server
		err = remote.call(ctx, "POST", "/v1/mcp-servers", map[string]any{"name": m.Name + suffix, "description": m.Description, "source": "user", "enabled": true, "transport": transport, "toolPolicy": m.ToolPolicy, "allowedTools": m.AllowedTools, "oauthState": "none"}, &created)
		if err != nil {
			return state, err
		}
		state.MCP[m.ID] = created.ID
		if err = save(); err != nil {
			return state, err
		}
	}
	for index, skill := range b.Skills {
		target := ""
		for _, current := range skills {
			if (skill.Builtin && (current.ID == skill.ID || current.Name == skill.Name)) || current.ID == state.Skills[skill.ID] || current.Name == skill.Name+suffix {
				target = current.ID
				break
			}
		}
		if target != "" {
			state.Skills[skill.ID] = target
			continue
		}
		if skill.Builtin {
			return state, errors.New("market_builtin_dependency_unavailable")
		}
		metadata, _ := json.Marshal(map[string]string{"id": fmt.Sprintf("market-%s-%d", e.ID, index), "name": skill.Name + suffix, "description": skill.Description, "version": skill.Version})
		response, callErr := remote.send(ctx, "POST", "/v1/skills/market-install", bytes.NewReader(skill.Archive), map[string]string{"Content-Type": "application/zip", "X-WorkAgent-Skill-Metadata": base64.RawURLEncoding.EncodeToString(metadata)})
		if callErr != nil {
			return state, callErr
		}
		var created skillruntime.Entry
		err = json.NewDecoder(response.Body).Decode(&created)
		response.Body.Close()
		if err != nil {
			return state, err
		}
		state.Skills[skill.ID] = created.ID
		if err = save(); err != nil {
			return state, err
		}
	}
	if a := b.Assistant; a != nil {
		exists := false
		for _, p := range presets {
			if p.ID == state.AssistantID || p.Name == e.Name+suffix {
				state.AssistantID = p.ID
				exists = true
				break
			}
		}
		if !exists {
			skillIDs := []string{}
			mcpIDs := []string{}
			for _, id := range a.SkillIDs {
				skillIDs = append(skillIDs, state.Skills[id])
			}
			for _, id := range a.MCPServerIDs {
				mcpIDs = append(mcpIDs, state.MCP[id])
			}
			var created struct {
				ID string `json:"id"`
			}
			err = remote.call(ctx, "POST", "/v1/presets", map[string]any{"name": e.Name + suffix, "engine": a.Engine, "description": a.Description, "modelId": nil, "enabled": false, "systemPrompt": a.SystemPrompt, "workspacePolicy": a.WorkspacePolicy, "skillIds": skillIDs, "mcpServerIds": mcpIDs, "toolAllowlist": a.ToolAllowlist, "approvalPolicy": a.ApprovalPolicy}, &created)
			if err != nil {
				return state, err
			}
			state.AssistantID = created.ID
			if err = save(); err != nil {
				return state, err
			}
			// Dependencies with credentials or review requirements remain installed and can be configured before activation.
			state.NeedsSetup = remote.call(ctx, "PATCH", "/v1/presets/"+url.PathEscape(created.ID), map[string]any{"enabled": true}, nil) != nil
		}
	}
	state.Complete = true
	return state, save()
}
