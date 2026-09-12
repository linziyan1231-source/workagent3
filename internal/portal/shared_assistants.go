package portal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

type sharedAssistantPreset struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Engine  string `json:"engine"`
	Enabled bool   `json:"enabled"`
	ModelID string `json:"modelId"`
}

type sharedAssistantReasoning struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type sharedAssistantModel struct {
	ID               string                     `json:"id"`
	Name             string                     `json:"name"`
	IsDefault        bool                       `json:"isDefault"`
	Reasoning        []sharedAssistantReasoning `json:"reasoning"`
	DefaultReasoning string                     `json:"defaultReasoning"`
}
type sharedEngineModels struct {
	Engine string                 `json:"engine"`
	Models []sharedAssistantModel `json:"models"`
}

func sharedBillingModel(models []contracts.AuthorizedModel, engine, selected string) string {
	for _, model := range models {
		if model.ProviderID == engine && model.ID == selected && model.Authorization.Authorized {
			return model.ID
		}
	}
	for _, model := range models {
		if model.ProviderID == engine && model.ID == engine+"-native" && model.Authorization.Authorized {
			return model.ID
		}
	}
	return ""
}
func sharedModelChoices(models []contracts.AuthorizedModel, catalogs []sharedEngineModels, engine string) []sharedAssistantModel {
	choices := []sharedAssistantModel{}
	for _, catalog := range catalogs {
		if catalog.Engine == engine {
			for _, model := range catalog.Models {
				if sharedBillingModel(models, engine, model.ID) != "" {
					choices = append(choices, model)
				}
			}
		}
	}
	// Keep the legacy logical ID usable, with the default native model's capabilities.
	for _, model := range models {
		if model.ID == engine+"-native" && model.Authorization.Authorized && model.ProviderID == engine {
			for _, choice := range choices {
				if choice.IsDefault {
					choice.ID = model.ID
					choice.Name = "默认模型（" + choice.Name + "）"
					choice.IsDefault = false
					choices = append(choices, choice)
					break
				}
			}
		}
	}
	return choices
}
func sharedModelSelection(choices []sharedAssistantModel, model, effort string) (string, string, bool) {
	if model == "" {
		for _, choice := range choices {
			if model == "" || choice.IsDefault {
				model = choice.ID
			}
			if choice.IsDefault {
				break
			}
		}
	}
	for _, choice := range choices {
		if choice.ID != model {
			continue
		}
		if effort == "" {
			effort = choice.DefaultReasoning
			if effort == "" && len(choice.Reasoning) > 0 {
				effort = choice.Reasoning[0].ID
			}
			if effort == "" {
				effort = "off"
			}
		}
		if len(choice.Reasoning) == 0 {
			return model, effort, effort == "off"
		}
		for _, value := range choice.Reasoning {
			if value.ID == effort {
				return model, effort, true
			}
		}
	}
	return model, effort, false
}

func (s *Server) sharedAssistantOptions(w http.ResponseWriter, r *http.Request, user store.User) {
	project, err := s.modules.Collaboration.ProjectForUser(r.Context(), r.PathValue("id"), user.ID, true)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	if project.CurrentRole != "owner" {
		writeCollaborationError(w, collaboration.ErrForbidden)
		return
	}
	presets, err := s.sharedAssistantPresets(r.Context(), project.OwnerSID)
	if err != nil {
		writeError(w, 503, "shared_assistant_catalog_unavailable")
		return
	}
	models, err := s.modules.ModelAccess.ListAuthorized(r.Context(), project.OwnerSID)
	if err != nil {
		writeError(w, 503, "model_access_failed")
		return
	}
	var catalogs []sharedEngineModels
	if err = s.sharedRuntimeCatalog(r.Context(), project.OwnerSID, "/v1/model-options", &catalogs); err != nil {
		writeError(w, 503, "shared_assistant_catalog_unavailable")
		return
	}
	options := []map[string]any{}
	for _, preset := range presets {
		if !preset.Enabled || (preset.Engine != "codex" && preset.Engine != "kimi") {
			continue
		}
		choices := sharedModelChoices(models, catalogs, preset.Engine)
		if len(choices) > 0 {
			options = append(options, map[string]any{"id": preset.ID, "name": preset.Name, "engine": preset.Engine, "modelId": preset.ModelID, "models": choices})
		}
	}
	writeJSON(w, 200, map[string]any{"assistants": options})
}
func (s *Server) sharedAssistantPresets(ctx context.Context, sid string) ([]sharedAssistantPreset, error) {
	var values []sharedAssistantPreset
	err := s.sharedRuntimeCatalog(ctx, sid, "/v1/presets", &values)
	return values, err
}
func (s *Server) sharedRuntimeCatalog(ctx context.Context, sid, path string, value any) error {
	endpoint, err := s.runtimes.Resolve(ctx, sid)
	if err != nil {
		return err
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: path})
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return collaboration.ErrNotFound
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4*1024*1024)).Decode(value)
}
func (s *Server) sharedAssistantMembers(w http.ResponseWriter, r *http.Request, user store.User) {
	values, err := s.modules.Collaboration.AssistantMembers(r.Context(), r.PathValue("id"), user.ID)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"assistants": values})
}
func (s *Server) sharedAssistantInvite(w http.ResponseWriter, r *http.Request, user store.User) {
	var input struct {
		AssistantID string `json:"assistant_id"`
		ModelID     string `json:"model_id"`
		Effort      string `json:"thinking_effort"`
	}
	if !decodeJSON(r, &input, 16*1024) || input.AssistantID == "" {
		writeError(w, 400, "invalid_shared_assistant_invite")
		return
	}
	project, err := s.modules.Collaboration.ProjectForUser(r.Context(), r.PathValue("id"), user.ID, true)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	if project.CurrentRole != "owner" {
		writeCollaborationError(w, collaboration.ErrForbidden)
		return
	}
	presets, err := s.sharedAssistantPresets(r.Context(), project.OwnerSID)
	if err != nil {
		writeError(w, 503, "shared_assistant_catalog_unavailable")
		return
	}
	var preset sharedAssistantPreset
	for _, p := range presets {
		if p.ID == input.AssistantID && p.Enabled {
			preset = p
			break
		}
	}
	if preset.ID == "" || (preset.Engine != "codex" && preset.Engine != "kimi") {
		writeError(w, 400, "shared_assistant_unavailable")
		return
	}
	models, err := s.modules.ModelAccess.ListAuthorized(r.Context(), project.OwnerSID)
	if err != nil {
		writeError(w, 503, "model_access_failed")
		return
	}
	var catalogs []sharedEngineModels
	if err = s.sharedRuntimeCatalog(r.Context(), project.OwnerSID, "/v1/model-options", &catalogs); err != nil {
		writeError(w, 503, "shared_assistant_catalog_unavailable")
		return
	}
	choices := sharedModelChoices(models, catalogs, preset.Engine)
	if input.ModelID == "" {
		for _, model := range choices {
			if model.ID == preset.ModelID {
				input.ModelID = preset.ModelID
				break
			}
		}
	}
	var valid bool
	input.ModelID, input.Effort, valid = sharedModelSelection(choices, input.ModelID, input.Effort)
	if !valid {
		writeError(w, 400, "invalid_shared_runtime")
		return
	}
	sharedMessageMu.Lock()
	defer sharedMessageMu.Unlock()
	member, err := s.modules.Collaboration.InviteAssistant(r.Context(), collaboration.AssistantMember{ProjectID: project.ID, AssistantID: preset.ID, Name: preset.Name, Backend: preset.Engine, ModelID: input.ModelID, ThinkingEffort: input.Effort}, user.ID)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	s.recordBusinessEvent(r.Context(), user.SID, "collaboration.assistant.invite", project.ID, nil, map[string]string{"assistantId": member.AssistantID, "status": "accepted"})

	writeJSON(w, 201, map[string]any{"member": member, "invite": map[string]string{"kind": "assistant", "status": "accepted"}})
}
func (s *Server) sharedAssistantSettings(w http.ResponseWriter, r *http.Request, user store.User) {
	sharedMessageMu.Lock()
	defer sharedMessageMu.Unlock()
	if r.Method == http.MethodDelete {
		if err := s.modules.Collaboration.RemoveAssistant(r.Context(), r.PathValue("id"), r.PathValue("assistantID"), user.ID); err != nil {
			writeCollaborationError(w, err)
			return
		}

		w.WriteHeader(204)
		return
	}
	var input struct {
		ModelID string `json:"model_id"`
		Effort  string `json:"thinking_effort"`
	}
	if !decodeJSON(r, &input, 16*1024) {
		writeError(w, 400, "invalid_shared_runtime")
		return
	}
	project, err := s.modules.Collaboration.ProjectForUser(r.Context(), r.PathValue("id"), user.ID, true)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	if project.CurrentRole != "owner" {
		writeCollaborationError(w, collaboration.ErrForbidden)
		return
	}
	members, err := s.modules.Collaboration.AssistantMembers(r.Context(), project.ID, user.ID)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	var member collaboration.AssistantMember
	for _, a := range members {
		if a.AssistantID == r.PathValue("assistantID") {
			member = a
			break
		}
	}
	if member.AssistantID == "" {
		writeCollaborationError(w, collaboration.ErrNotFound)
		return
	}
	models, err := s.modules.ModelAccess.ListAuthorized(r.Context(), project.OwnerSID)
	if err != nil {
		writeError(w, 503, "model_access_failed")
		return
	}
	if sharedBillingModel(models, member.Backend, input.ModelID) == "" {
		writeError(w, 403, "shared_runtime_not_authorized")
		return
	}
	var catalogs []sharedEngineModels
	if err = s.sharedRuntimeCatalog(r.Context(), project.OwnerSID, "/v1/model-options", &catalogs); err != nil {
		writeError(w, 503, "shared_assistant_catalog_unavailable")
		return
	}
	if _, _, valid := sharedModelSelection(sharedModelChoices(models, catalogs, member.Backend), input.ModelID, input.Effort); !valid {
		writeError(w, 400, "invalid_shared_runtime")
		return
	}
	member, err = s.modules.Collaboration.UpdateAssistantSettings(r.Context(), project.ID, member.AssistantID, user.ID, input.ModelID, input.Effort)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}

	writeJSON(w, 200, map[string]any{"member": member})
}
