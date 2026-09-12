package portal

import (
	"net/http"
	"regexp"
	"sync"

	"workagent3/internal/collaboration"
	"workagent3/internal/store"
)

var sharedCreationMu sync.Mutex
var sharedMessageMu sync.Mutex
var sharedOperationPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

func (s *Server) writeCreatedSharedProject(w http.ResponseWriter, r *http.Request, user store.User, project collaboration.Project) {
	conversation, err := s.modules.Collaboration.DefaultConversation(r.Context(), project.ID, user.ID)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"project": projectDTO(project), "conversation": conversationDTO(conversation)})
}

func (s *Server) sharedDefaultDiscussion(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(w, 503, "collaboration_unavailable")
		return
	}
	value, err := s.modules.Collaboration.DefaultConversation(r.Context(), r.PathValue("id"), user.ID)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": conversationDTO(value)})
}

func (s *Server) sharedOutgoingInvites(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(w, 503, "collaboration_unavailable")
		return
	}
	values, err := s.modules.Collaboration.ProjectInvites(r.Context(), r.PathValue("id"), user.ID)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	result := []any{}
	for _, invite := range values {
		target, err := s.store.UserByID(r.Context(), invite.TargetUserID)
		if err != nil {
			writeError(w, 500, "shared_invites_failed")
			return
		}
		result = append(result, map[string]any{"id": invite.ID, "projectId": invite.ProjectID, "targetUserId": invite.TargetUserID, "displayName": target.DisplayName, "username": target.Username, "status": invite.Status, "expiresAt": invite.ExpiresAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": result})
}

func (s *Server) sharedRevokeInvite(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(w, 503, "collaboration_unavailable")
		return
	}
	if err := s.modules.Collaboration.RevokeInvite(r.Context(), r.PathValue("id"), user.ID); err != nil {
		writeCollaborationError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) sharedBindAssistant(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(w, 503, "collaboration_unavailable")
		return
	}
	var input struct {
		AssistantID string `json:"assistant_id"`
		Backend     string `json:"assistant_backend"`
		ModelID     string `json:"model_id"`
		Effort      string `json:"thinking_effort"`
	}
	if !decodeJSON(r, &input, 16*1024) {
		writeError(w, 400, "invalid_shared_runtime")
		return
	}
	// Use the message admission lock so the first @ cannot race a settings save.
	sharedMessageMu.Lock()
	defer sharedMessageMu.Unlock()
	if input.AssistantID != "" {
		if s.modules.ModelAccess == nil {
			writeError(w, 503, "model_access_unavailable")
			return
		}
		models, err := s.modules.ModelAccess.ListAuthorized(r.Context(), user.SID)
		if err != nil {
			writeError(w, 503, "model_access_failed")
			return
		}
		allowed := false
		for _, model := range models {
			if model.ID == input.ModelID && model.ProviderID == input.Backend && model.Authorization.Authorized {
				allowed = true
				break
			}
		}
		if !allowed {
			writeError(w, 403, "shared_runtime_not_authorized")
			return
		}
	}
	value, err := s.modules.Collaboration.BindAssistant(r.Context(), r.PathValue("id"), user.ID, input.AssistantID, input.Backend, input.ModelID, input.Effort)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"conversation": conversationDTO(value)})
}
