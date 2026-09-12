package portal

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"time"
	"workagent3/internal/auth"
	"workagent3/internal/marketplace"
	"workagent3/internal/store"
)

func (s *Server) marketVersions(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil {
		writeError(w, 503, "market_unavailable")
		return
	}
	versions, err := s.modules.Marketplace.Versions(r.Context(), r.URL.Query().Get("seriesId"), false)
	if err != nil {
		marketError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"versions": versions})
}

// A new snapshot can reuse an unchanged connection, including the recipient's credentials.
// Changed transports are installed separately and require the recipient's explicit setup.
func (s *Server) installMarketVersion(ctx context.Context, user store.User, e marketplace.Entry, b marketplace.Bundle, secrets map[string]map[string]string) (marketplace.Installation, error) {
	endpoint, err := s.runtimes.Resolve(ctx, user.SID)
	if err != nil {
		return marketplace.Installation{}, err
	}
	state, err := s.modules.Marketplace.Installation(ctx, user.SID, e.ID)
	if err != nil {
		return state, err
	}
	previous, err := s.modules.Marketplace.InstalledVersions(ctx, user.SID, e.SeriesID)
	if err != nil {
		return state, err
	}
	for oldID, old := range previous {
		if oldID == e.ID {
			continue
		}
		_, oldBundle, lookup := s.modules.Marketplace.Snapshot(ctx, oldID)
		if lookup != nil {
			return state, lookup
		}
		for _, m := range b.MCP {
			for _, before := range oldBundle.MCP {
				if state.MCP[m.ID] == "" && m.ID == before.ID && reflect.DeepEqual(m, before) && old.MCP[m.ID] != "" {
					state.MCP[m.ID] = old.MCP[m.ID]
				}
			}
		}
	}
	if err = s.modules.Marketplace.SaveInstallation(ctx, user.SID, e.ID, state); err != nil {
		return state, err
	}
	return s.installBundle(ctx, marketRuntime{endpoint: endpoint}, user, e, b, secrets)
}

type marketChange struct {
	Skills     map[string]string `json:"skills"`
	MCP        map[string]string `json:"mcp"`
	Assistants map[string]string `json:"assistants"`
	Urgent     bool              `json:"urgent"`
}

func versionChange(old, next marketplace.Installation, urgent bool) marketChange {
	v := marketChange{Skills: map[string]string{}, MCP: map[string]string{}, Assistants: map[string]string{}, Urgent: urgent}
	for source, id := range old.Skills {
		if id != next.Skills[source] {
			v.Skills[id] = next.Skills[source]
		}
	}
	// A standalone skill may have been re-imported under a new source ID by its author.
	if len(old.Skills) == 1 && len(next.Skills) == 1 {
		for _, id := range old.Skills {
			for _, target := range next.Skills {
				if id != target {
					v.Skills[id] = target
				}
			}
		}
	}
	for source, id := range old.MCP {
		if id != next.MCP[source] {
			v.MCP[id] = next.MCP[source]
		}
	}
	if old.AssistantID != "" && old.AssistantID != next.AssistantID {
		v.Assistants[old.AssistantID] = next.AssistantID
	}
	return v
}
func (s *Server) updateMarketVersion(ctx context.Context, user store.User, id string, secrets map[string]map[string]string) (marketplace.Installation, error) {
	e, b, err := s.modules.Marketplace.Get(ctx, id)
	if err != nil {
		return marketplace.Installation{}, err
	}
	_, old, err := s.modules.Marketplace.Selection(ctx, user.SID, e.SeriesID)
	if err != nil {
		return old, err
	}
	next, err := s.installMarketVersion(ctx, user, e, b, secrets)
	if err != nil {
		return next, err
	}
	endpoint, err := s.runtimes.Resolve(ctx, user.SID)
	if err != nil {
		return next, err
	}
	if err = (marketRuntime{endpoint: endpoint}).call(ctx, "POST", "/v1/market-capabilities/change", versionChange(old, next, false), nil); err != nil {
		return next, err
	}
	if err = s.modules.Marketplace.Select(ctx, user.SID, e); err != nil {
		return next, err
	}
	return next, nil
}
func (s *Server) marketUpdate(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil {
		writeError(w, 503, "market_unavailable")
		return
	}
	var input struct {
		ID          string                       `json:"id"`
		All         bool                         `json:"all"`
		Credentials map[string]map[string]string `json:"credentials"`
	}
	if !decodeJSON(r, &input, 256*1024) || (!input.All && input.ID == "") {
		writeError(w, 400, "invalid_market_update")
		return
	}
	s.modules.Marketplace.InstallMu.Lock()
	defer s.modules.Marketplace.InstallMu.Unlock()
	ids := []string{input.ID}
	if input.All {
		ids = []string{}
		entries, err := s.modules.Marketplace.Catalog(r.Context(), user.Username, user.SID)
		if err != nil {
			marketError(w, err)
			return
		}
		for _, e := range entries {
			if e.UpdateAvailable {
				ids = append(ids, e.ID)
			}
		}
	}
	results := []map[string]any{}
	for _, id := range ids {
		next, err := s.updateMarketVersion(r.Context(), user, id, input.Credentials)
		row := map[string]any{"id": id, "success": err == nil, "installation": next}
		if err != nil {
			row["error"] = err.Error()
		}
		results = append(results, row)
		s.recordBusinessEvent(r.Context(), user.SID, "market.update", id, err, nil)
	}
	writeJSON(w, 200, map[string]any{"results": results})
}

type projectCapabilities struct {
	SkillIDs         []string `json:"skillIds"`
	MCPServerIDs     []string `json:"mcpServerIds"`
	EntryIDs         []string `json:"entryIds"`
	ExcludedSkillIDs []string `json:"excludedSkillIds"`
	ExcludedMCPIDs   []string `json:"excludedMcpIds"`
}

func (s *Server) resolveProjectCapabilities(ctx context.Context, projectID string, owner store.User) (projectCapabilities, error) {
	result := projectCapabilities{SkillIDs: []string{}, MCPServerIDs: []string{}, EntryIDs: []string{}, ExcludedSkillIDs: []string{}, ExcludedMCPIDs: []string{}}
	if s.modules.Marketplace == nil {
		return result, nil
	}
	subscriptions, err := s.modules.Marketplace.Subscriptions(ctx, projectID)
	if err != nil {
		return result, err
	}
	for _, sub := range subscriptions {
		e, b, err := s.modules.Marketplace.Snapshot(ctx, sub.EntryID)
		if err != nil || e.Revoked {
			return result, errors.New("project_capability_unavailable")
		}
		state, err := s.modules.Marketplace.Installation(ctx, owner.SID, e.ID)
		if err != nil {
			return result, err
		}
		if !state.Complete {
			state, err = s.installMarketVersion(ctx, owner, e, b, nil)
			if err != nil {
				return result, err
			}
		}
		others, err := s.modules.Marketplace.InstalledVersions(ctx, owner.SID, e.SeriesID)
		if err != nil {
			return result, err
		}
		for _, v := range others {
			for _, id := range v.Skills {
				result.ExcludedSkillIDs = append(result.ExcludedSkillIDs, id)
			}
			for _, id := range v.MCP {
				result.ExcludedMCPIDs = append(result.ExcludedMCPIDs, id)
			}
		}
		for _, v := range state.Skills {
			result.SkillIDs = append(result.SkillIDs, v)
		}
		for _, v := range state.MCP {
			result.MCPServerIDs = append(result.MCPServerIDs, v)
		}
		result.EntryIDs = append(result.EntryIDs, e.ID)
	}
	result.SkillIDs = uniqueIDs(result.SkillIDs)
	result.MCPServerIDs = uniqueIDs(result.MCPServerIDs)
	return result, nil
}
func (s *Server) projectSubscriptions(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil || s.modules.Collaboration == nil {
		writeError(w, 503, "market_unavailable")
		return
	}
	project, err := s.modules.Collaboration.ProjectForUser(r.Context(), r.PathValue("id"), user.ID, false)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	s.serveProjectSubscriptions(w, r, user, project.ID, project.OwnerUserID == user.ID)
}

func personalSubscriptionKey(sid, workspace string) string {
	return "personal:" + sid + ":" + workspace
}
func (s *Server) personalProjectSubscriptions(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil {
		writeError(w, 503, "market_unavailable")
		return
	}
	endpoint, err := s.runtimes.Resolve(r.Context(), user.SID)
	if err != nil {
		marketError(w, err)
		return
	}
	var workspaces []struct {
		ID string `json:"id"`
	}
	if err = (marketRuntime{endpoint: endpoint}).call(r.Context(), "GET", "/v1/workspaces", nil, &workspaces); err != nil {
		marketError(w, err)
		return
	}
	workspace := r.PathValue("id")
	found := workspace == "default"
	for _, v := range workspaces {
		if v.ID == workspace {
			found = true
		}
	}
	if !found {
		writeError(w, 404, "workspace_not_found")
		return
	}
	s.serveProjectSubscriptions(w, r, user, personalSubscriptionKey(user.SID, workspace), true)
}
func (s *Server) serveProjectSubscriptions(w http.ResponseWriter, r *http.Request, user store.User, projectID string, canManage bool) {
	var err error
	if r.Method != "GET" && !canManage {
		writeError(w, 403, "project_owner_required")
		return
	}
	if r.Method == "POST" {
		var input struct {
			ID          string                       `json:"id"`
			Credentials map[string]map[string]string `json:"credentials"`
		}
		if !decodeJSON(r, &input, 256*1024) || input.ID == "" {
			writeError(w, 400, "invalid_market_install")
			return
		}
		s.modules.Marketplace.InstallMu.Lock()
		defer s.modules.Marketplace.InstallMu.Unlock()
		e, b, err := s.modules.Marketplace.Get(r.Context(), input.ID)
		if err != nil {
			marketError(w, err)
			return
		}
		if e.Kind == "assistant" {
			writeError(w, 400, "project_subscribe_skill_or_mcp")
			return
		}
		if _, err = s.installMarketVersion(r.Context(), user, e, b, input.Credentials); err == nil {
			err = s.modules.Marketplace.Subscribe(r.Context(), projectID, e)
		}
		s.recordBusinessEvent(r.Context(), user.SID, "project.capability.subscribe", projectID, err, map[string]string{"entry_id": e.ID})
		if err != nil {
			marketError(w, err)
			return
		}
	}
	if r.Method == "DELETE" {
		err = s.modules.Marketplace.Unsubscribe(r.Context(), projectID, r.URL.Query().Get("seriesId"))
		s.recordBusinessEvent(r.Context(), user.SID, "project.capability.unsubscribe", projectID, err, nil)
		if err != nil {
			marketError(w, err)
			return
		}
	}
	rows, err := s.modules.Marketplace.Subscriptions(r.Context(), projectID)
	if err != nil {
		marketError(w, err)
		return
	}
	entries := []map[string]any{}
	for _, row := range rows {
		e, _, err := s.modules.Marketplace.Snapshot(r.Context(), row.EntryID)
		if err != nil {
			marketError(w, err)
			return
		}
		versions, err := s.modules.Marketplace.Versions(r.Context(), row.SeriesID, false)
		if err != nil {
			marketError(w, err)
			return
		}
		latest := e
		if len(versions) > 0 {
			latest = versions[0]
		}
		entries = append(entries, map[string]any{"entry": e, "latest": latest, "updateAvailable": marketplace.Newer(latest.Version, e.Version)})
	}
	writeJSON(w, 200, map[string]any{"subscriptions": entries, "canManage": canManage})
}

func (s *Server) adminMarket(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil {
		writeError(w, 503, "market_unavailable")
		return
	}
	if err := s.importLegacyMarket(r.Context(), user); err != nil {
		marketError(w, err)
		return
	}
	if r.Method == "POST" {
		var input struct {
			SeriesID string `json:"seriesId"`
			TargetID string `json:"targetId"`
			Action   string `json:"action"`
			Reason   string `json:"reason"`
			RetryID  string `json:"retryId"`
		}
		if !decodeJSON(r, &input, 16*1024) {
			writeError(w, 400, "invalid_market_action")
			return
		}
		if input.RetryID != "" {
			go s.processMarketActions()
			writeJSON(w, 202, map[string]any{"queued": true})
			return
		}
		if input.SeriesID == "" || strings.TrimSpace(input.Reason) == "" || len(input.Reason) > 2000 || (input.Action != "update" && input.Action != "disable" && input.Action != "delete" && input.Action != "unlist" && input.Action != "relist") {
			writeError(w, 400, "invalid_market_action")
			return
		}
		versions, err := s.modules.Marketplace.Versions(r.Context(), input.SeriesID, true)
		if err != nil || len(versions) == 0 {
			writeError(w, 404, "market_entry_not_found")
			return
		}
		if versions[0].Kind != "skill" {
			writeError(w, 400, "market_action_requires_skill")
			return
		}
		if input.Action == "unlist" || input.Action == "relist" {
			// Lightweight listing toggle: no employee targets, nothing to process per runtime.
			id, err := auth.RandomToken(18)
			if err != nil {
				marketError(w, err)
				return
			}
			a := marketplace.Action{ID: id, SeriesID: input.SeriesID, Action: input.Action, Reason: input.Reason, Actor: user.Username, Targets: []marketplace.ActionTarget{}}
			s.modules.Marketplace.InstallMu.Lock()
			err = s.modules.Marketplace.CreateAction(r.Context(), a)
			s.modules.Marketplace.InstallMu.Unlock()
			s.recordBusinessEvent(r.Context(), user.SID, "market.admin."+a.Action, a.ID, err, map[string]string{"series_id": a.SeriesID, "reason": a.Reason})
			if err != nil {
				marketError(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"id": id})
			return
		}
		if input.Action == "update" {
			e, _, err := s.modules.Marketplace.Get(r.Context(), input.TargetID)
			if err != nil || e.SeriesID != input.SeriesID {
				writeError(w, 400, "invalid_market_update_target")
				return
			}
		}
		users, err := s.store.ListRuntimeUsers(r.Context())
		if err != nil {
			marketError(w, err)
			return
		}
		id, err := auth.RandomToken(18)
		if err != nil {
			marketError(w, err)
			return
		}
		a := marketplace.Action{ID: id, SeriesID: input.SeriesID, TargetID: input.TargetID, Action: input.Action, Reason: input.Reason, Actor: user.Username, Targets: []marketplace.ActionTarget{}}
		for _, u := range users {
			a.Targets = append(a.Targets, marketplace.ActionTarget{SID: u.SID})
		}
		s.modules.Marketplace.InstallMu.Lock()
		err = s.modules.Marketplace.CreateAction(r.Context(), a)
		s.modules.Marketplace.InstallMu.Unlock()
		s.recordBusinessEvent(r.Context(), user.SID, "market.admin."+a.Action, a.ID, err, map[string]string{"series_id": a.SeriesID, "reason": a.Reason})
		if err != nil {
			marketError(w, err)
			return
		}
		go s.processMarketActions()
		writeJSON(w, 202, map[string]any{"id": id})
		return
	}
	entries, err := s.modules.Marketplace.Versions(r.Context(), "", true)
	if err != nil {
		marketError(w, err)
		return
	}
	actions, err := s.modules.Marketplace.Actions(r.Context())
	if err != nil {
		marketError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"entries": entries, "actions": actions})
}
func (s *Server) processMarketActions() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	users, err := s.store.ListRuntimeUsers(ctx)
	if err != nil {
		return
	}
	for _, u := range users {
		_ = s.applyMarketActions(ctx, u)
	}
}
func (s *Server) applyMarketActions(ctx context.Context, user store.User) error {
	if s.modules.Marketplace == nil {
		return nil
	}
	// Adopt an offline employee's historical installations before applying a queued revocation.
	queued, err := s.modules.Marketplace.Actions(ctx)
	if err != nil {
		return err
	}
	pending := false
	for _, a := range queued {
		for _, t := range a.Targets {
			if t.SID == user.SID && t.State == "pending" {
				pending = true
			}
		}
	}
	if !pending {
		return nil
	}
	if err = s.importLegacyMarket(ctx, user); err != nil {
		return err
	}
	s.modules.Marketplace.InstallMu.Lock()
	defer s.modules.Marketplace.InstallMu.Unlock()
	actions, err := s.modules.Marketplace.Actions(ctx)
	if err != nil {
		return err
	}
	// Oldest first: retrying a previous action must never undo a newer revocation.
	for i := len(actions) - 1; i >= 0; i-- {
		a := actions[i]
		for _, target := range a.Targets {
			if target.SID != user.SID || target.State != "pending" {
				continue
			}
			err = s.applyMarketAction(ctx, user, a)
			state := "complete"
			reason := ""
			if err != nil {
				state = "pending"
				reason = err.Error()
			}
			_ = s.modules.Marketplace.FinishTarget(ctx, a.ID, user.SID, state, reason)
			if err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *Server) applyMarketAction(ctx context.Context, user store.User, a marketplace.Action) error {
	installs, err := s.modules.Marketplace.InstalledVersions(ctx, user.SID, a.SeriesID)
	if err != nil {
		return err
	}
	if len(installs) == 0 {
		return s.modules.Marketplace.ApplyProjectAction(ctx, a)
	}
	endpoint, err := s.runtimes.Resolve(ctx, user.SID)
	if err != nil {
		return errors.New("employee_runtime_pending")
	}
	remote := marketRuntime{endpoint: endpoint}
	next := marketplace.Installation{}
	if a.Action == "update" {
		e, b, err := s.modules.Marketplace.Get(ctx, a.TargetID)
		if err != nil {
			return err
		}
		next, err = s.installMarketVersion(ctx, user, e, b, nil)
		if err != nil {
			return err
		}
		if err = s.modules.Marketplace.Select(ctx, user.SID, e); err != nil {
			return err
		}
	}
	for id, old := range installs {
		if a.Action == "update" && id == a.TargetID {
			continue
		}
		change := versionChange(old, next, true)
		if err = remote.call(ctx, "POST", "/v1/market-capabilities/change", change, nil); err != nil {
			return err
		}
		_, b, err := s.modules.Marketplace.Snapshot(ctx, id)
		if err != nil {
			return err
		}
		for _, skill := range b.Skills {
			if skill.Builtin {
				continue
			}
			target := old.Skills[skill.ID]
			if target == "" || target == next.Skills[skill.ID] {
				continue
			}
			if err = remote.call(ctx, "POST", "/internal/skills/"+url.PathEscape(target)+"/revoke", map[string]any{"remove": a.Action == "delete"}, nil); err != nil {
				return err
			}
		}
	}
	return s.modules.Marketplace.ApplyProjectAction(ctx, a)
}
