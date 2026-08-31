package portal

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/store"
)

type sharedConversationDTO struct {
	ID               string     `json:"id"`
	ProjectID        string     `json:"project_id"`
	ProjectName      string     `json:"project_name"`
	Role             string     `json:"role"`
	Name             string     `json:"name"`
	AssistantID      string     `json:"assistant_id"`
	AssistantBackend string     `json:"assistant_backend"`
	ModelID          string     `json:"model_id"`
	ThinkingEffort   string     `json:"thinking_effort"`
	State            string     `json:"state"`
	LastAIMessageSeq int64      `json:"last_ai_message_seq"`
	Pinned           bool       `json:"pinned"`
	PinnedAt         *time.Time `json:"pinned_at,omitempty"`
	Hidden           bool       `json:"hidden"`
	CreatedAt        string     `json:"created_at"`
	UpdatedAt        string     `json:"updated_at"`
}

type sharedMessageDTO struct {
	Seq           int64                   `json:"seq"`
	ID            string                  `json:"id"`
	Conversation  string                  `json:"conversation_id"`
	AuthorUserID  *int64                  `json:"author_user_id,omitempty"`
	AuthorName    string                  `json:"author_name"`
	Kind          string                  `json:"kind"`
	Body          string                  `json:"body"`
	Mentions      []collaboration.Mention `json:"mentions"`
	Attachments   []string                `json:"attachments"`
	CreatedAt     string                  `json:"created_at"`
	IsCurrentUser bool                    `json:"is_current_user"`
}

func (s *Server) sharedConversations(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	switch request.Method {
	case http.MethodGet:
		id := strings.TrimSpace(request.URL.Query().Get("id"))
		if id != "" {
			value, err := s.modules.Collaboration.ConversationForUser(request.Context(), id, user.ID, true)
			if err != nil {
				writeCollaborationError(writer, err)
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"conversation": conversationDTO(value)})
			return
		}
		values, err := s.modules.Collaboration.ListConversations(request.Context(), user.ID, request.URL.Query().Get("include_hidden") == "1" || request.URL.Query().Get("include_hidden") == "true")
		if err != nil {
			writeCollaborationError(writer, err)
			return
		}
		result := make([]sharedConversationDTO, 0, len(values))
		for _, value := range values {
			result = append(result, conversationDTO(value))
		}
		writeJSON(writer, http.StatusOK, map[string]any{"conversations": result})
	case http.MethodPost:
		var input struct {
			ProjectID        string `json:"project_id"`
			Name             string `json:"name"`
			AssistantID      string `json:"assistant_id"`
			AssistantBackend string `json:"assistant_backend"`
			ModelID          string `json:"model_id"`
			ThinkingEffort   string `json:"thinking_effort"`
		}
		if !decodeJSON(request, &input, 32*1024) {
			writeError(writer, http.StatusBadRequest, "invalid_shared_conversation")
			return
		}
		id, err := auth.RandomToken(18)
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "shared_conversation_failed")
			return
		}
		value, err := s.modules.Collaboration.CreateConversation(request.Context(), collaboration.Conversation{ID: id, ProjectID: input.ProjectID, Name: input.Name, AssistantID: input.AssistantID, AssistantBackend: input.AssistantBackend, ModelID: input.ModelID, ThinkingEffort: input.ThinkingEffort}, user.ID)
		if err != nil {
			writeCollaborationError(writer, err)
			return
		}
		writeJSON(writer, http.StatusCreated, map[string]any{"conversation": conversationDTO(value)})
	case http.MethodPatch:
		var input struct {
			ConversationID string  `json:"conversation_id"`
			Name           *string `json:"name"`
			Pinned         *bool   `json:"pinned"`
			Hidden         *bool   `json:"hidden"`
			ModelID        *string `json:"model_id"`
			ThinkingEffort *string `json:"thinking_effort"`
		}
		if !decodeJSON(request, &input, 16*1024) || strings.TrimSpace(input.ConversationID) == "" {
			writeError(writer, http.StatusBadRequest, "invalid_shared_conversation_update")
			return
		}
		runtimeUpdate := input.ModelID != nil || input.ThinkingEffort != nil
		metadataUpdate := input.Name != nil || input.Pinned != nil || input.Hidden != nil
		if runtimeUpdate == metadataUpdate {
			writeError(writer, http.StatusBadRequest, "invalid_shared_conversation_update")
			return
		}
		var value collaboration.Conversation
		var err error
		if metadataUpdate {
			value, err = s.modules.Collaboration.UpdateConversationMetadata(request.Context(), input.ConversationID, user.ID, input.Name, input.Pinned, input.Hidden)
		} else {
			current, lookupErr := s.modules.Collaboration.ConversationForUser(request.Context(), input.ConversationID, user.ID, true)
			if lookupErr != nil {
				writeCollaborationError(writer, lookupErr)
				return
			}
			modelID, effort := current.ModelID, current.ThinkingEffort
			if input.ModelID != nil {
				modelID = strings.TrimSpace(*input.ModelID)
			}
			if input.ThinkingEffort != nil {
				effort = strings.TrimSpace(*input.ThinkingEffort)
			}
			if effort != "low" && effort != "medium" && effort != "high" {
				writeError(writer, http.StatusBadRequest, "invalid_shared_runtime")
				return
			}
			if s.modules.ModelAccess == nil {
				writeError(writer, http.StatusServiceUnavailable, "model_access_unavailable")
				return
			}
			models, modelErr := s.modules.ModelAccess.ListAuthorized(request.Context(), user.SID)
			if modelErr != nil {
				writeError(writer, http.StatusInternalServerError, "model_access_failed")
				return
			}
			authorized := false
			for _, model := range models {
				if model.ID == modelID && model.ProviderID == current.AssistantBackend && model.Authorization.Authorized {
					authorized = true
					break
				}
			}
			if !authorized {
				writeError(writer, http.StatusForbidden, "shared_runtime_not_authorized")
				return
			}
			value, err = s.modules.Collaboration.UpdateConversationRuntime(request.Context(), input.ConversationID, user.ID, modelID, effort)
		}
		if err != nil {
			writeCollaborationError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"conversation": conversationDTO(value)})
	}
}

func (s *Server) sharedMessages(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	if request.Method == http.MethodGet {
		after, _ := strconv.ParseInt(request.URL.Query().Get("after"), 10, 64)
		limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
		values, err := s.modules.Collaboration.ListMessages(request.Context(), request.URL.Query().Get("conversation_id"), user.ID, after, limit)
		if err != nil {
			writeCollaborationError(writer, err)
			return
		}
		result := make([]sharedMessageDTO, 0, len(values))
		for _, value := range values {
			result = append(result, messageDTO(value, user.ID))
		}
		writeJSON(writer, http.StatusOK, map[string]any{"messages": result})
		return
	}
	var input struct {
		ConversationID string                  `json:"conversation_id"`
		Body           string                  `json:"body"`
		Mentions       []collaboration.Mention `json:"mentions"`
		Attachments    []string                `json:"attachments"`
	}
	if !decodeJSON(request, &input, 160*1024) {
		writeError(writer, http.StatusBadRequest, "invalid_shared_message")
		return
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_message_failed")
		return
	}
	value, err := s.modules.Collaboration.AddMessage(request.Context(), collaboration.Message{ID: id, Conversation: input.ConversationID, AuthorName: user.DisplayName, Kind: "user", Body: input.Body, Mentions: input.Mentions, Attachments: input.Attachments}, user.ID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	s.sharedEvents.publish(value)
	aiStarted := s.maybeStartSharedAI(request.Context(), value, user.ID)
	writeJSON(writer, http.StatusCreated, map[string]any{"message": messageDTO(value, user.ID), "ai_started": aiStarted})
}

func conversationDTO(value collaboration.Conversation) sharedConversationDTO {
	return sharedConversationDTO{ID: value.ID, ProjectID: value.ProjectID, ProjectName: value.ProjectName, Role: value.Role, Name: value.Name, AssistantID: value.AssistantID, AssistantBackend: value.AssistantBackend, ModelID: value.ModelID, ThinkingEffort: value.ThinkingEffort, State: value.State, LastAIMessageSeq: value.LastAIMessageSeq, Pinned: value.Pinned, PinnedAt: value.PinnedAt, Hidden: value.Hidden, CreatedAt: value.CreatedAt.Format(time.RFC3339Nano), UpdatedAt: value.UpdatedAt.Format(time.RFC3339Nano)}
}

func messageDTO(value collaboration.Message, currentUserID int64) sharedMessageDTO {
	return sharedMessageDTO{Seq: value.Seq, ID: value.ID, Conversation: value.Conversation, AuthorUserID: value.AuthorUserID, AuthorName: value.AuthorName, Kind: value.Kind, Body: value.Body, Mentions: value.Mentions, Attachments: value.Attachments, CreatedAt: value.CreatedAt.Format(time.RFC3339Nano), IsCurrentUser: value.AuthorUserID != nil && *value.AuthorUserID == currentUserID}
}
