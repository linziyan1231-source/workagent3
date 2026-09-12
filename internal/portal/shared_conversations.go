package portal

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

type sharedConversationDTO struct {
	ID               string                          `json:"id"`
	ProjectID        string                          `json:"project_id"`
	ProjectName      string                          `json:"project_name"`
	Role             string                          `json:"role"`
	Name             string                          `json:"name"`
	Kind             string                          `json:"kind"`
	CreatorUserID    int64                           `json:"creator_user_id"`
	RuntimeSessionID string                          `json:"runtime_session_id"`
	AssistantID      string                          `json:"assistant_id"`
	AssistantBackend string                          `json:"assistant_backend"`
	AssistantLocked  bool                            `json:"assistant_locked"`
	Assistants       []collaboration.AssistantMember `json:"assistants"`
	ModelID          string                          `json:"model_id"`
	ThinkingEffort   string                          `json:"thinking_effort"`
	State            string                          `json:"state"`
	LastAIMessageSeq int64                           `json:"last_ai_message_seq"`
	Pinned           bool                            `json:"pinned"`
	PinnedAt         *time.Time                      `json:"pinned_at,omitempty"`
	Hidden           bool                            `json:"hidden"`
	CreatedAt        string                          `json:"created_at"`
	UpdatedAt        string                          `json:"updated_at"`
}

type sharedMessageDTO struct {
	Seq               int64                   `json:"seq"`
	ID                string                  `json:"id"`
	Conversation      string                  `json:"conversation_id"`
	AuthorUserID      *int64                  `json:"author_user_id,omitempty"`
	AuthorName        string                  `json:"author_name"`
	Kind              string                  `json:"kind"`
	Body              string                  `json:"body"`
	Mentions          []collaboration.Mention `json:"mentions"`
	Attachments       []string                `json:"attachments"`
	CreatedAt         string                  `json:"created_at"`
	IsCurrentUser     bool                    `json:"is_current_user"`
	AuthorAssistantID string                  `json:"author_assistant_id,omitempty"`
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
			OperationID      string `json:"operation_id"`
			ProjectID        string `json:"project_id"`
			Name             string `json:"name"`
			Kind             string `json:"kind"`
			RuntimeSessionID string `json:"runtime_session_id"`
			AssistantID      string `json:"assistant_id"`
			AssistantBackend string `json:"assistant_backend"`
			ModelID          string `json:"model_id"`
			ThinkingEffort   string `json:"thinking_effort"`
		}
		if !decodeJSON(request, &input, 32*1024) {
			writeError(writer, http.StatusBadRequest, "invalid_shared_conversation")
			return
		}
		kind := strings.TrimSpace(input.Kind)
		if kind == "" {
			kind = "discussion"
		}
		if kind != "discussion" && kind != "personal_task" {
			writeError(writer, http.StatusBadRequest, "invalid_shared_conversation")
			return
		}
		// A personal task points at a runtime session on the creator's own
		// userhost; assistant binding fields do not apply to it.
		personalTask := kind == "personal_task"
		runtimeSessionID := ""
		creatorUserID := int64(0)
		if personalTask {
			runtimeSessionID = strings.TrimSpace(input.RuntimeSessionID)
			if runtimeSessionID == "" {
				writeError(writer, http.StatusBadRequest, "invalid_shared_conversation")
				return
			}
			creatorUserID = user.ID
			input.AssistantID, input.AssistantBackend, input.ModelID, input.ThinkingEffort = "", "", "", ""
			s.registerLegacyPersonalTask(writer, request, user, input.ProjectID, input.OperationID, input.Name, runtimeSessionID)
			return
		}
		project, lookupErr := s.modules.Collaboration.ProjectForUser(request.Context(), input.ProjectID, user.ID, true)
		if lookupErr != nil {
			writeCollaborationError(writer, lookupErr)
			return
		}
		if project.CurrentRole != "owner" && input.AssistantID != "" {
			writeCollaborationError(writer, collaboration.ErrForbidden)
			return
		}
		id, err := auth.RandomToken(18)
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "shared_conversation_failed")
			return
		}
		sharedCreationMu.Lock()
		defer sharedCreationMu.Unlock()
		if input.OperationID != "" {
			if !sharedOperationPattern.MatchString(input.OperationID) {
				writeError(writer, http.StatusBadRequest, "invalid_operation_id")
				return
			}
			id = "discussion_" + strconv.FormatInt(user.ID, 10) + "_" + input.OperationID
			if personalTask {
				id = "ptask_" + strconv.FormatInt(user.ID, 10) + "_" + input.OperationID
			}
			if existing, lookupErr := s.modules.Collaboration.ConversationForUser(request.Context(), id, user.ID, true); lookupErr == nil {
				if existing.ProjectID != input.ProjectID || existing.Name != strings.TrimSpace(input.Name) || existing.Kind != kind || existing.RuntimeSessionID != runtimeSessionID {
					writeError(writer, http.StatusConflict, "operation_conflict")
					return
				}
				writeJSON(writer, http.StatusOK, map[string]any{"conversation": conversationDTO(existing)})
				return
			} else if !errors.Is(lookupErr, collaboration.ErrNotFound) {
				writeCollaborationError(writer, lookupErr)
				return
			}
		}
		if input.AssistantID != "" {
			members, err := s.modules.Collaboration.AssistantMembers(request.Context(), input.ProjectID, user.ID)
			if err != nil {
				writeCollaborationError(writer, err)
				return
			}
			joined := false
			for _, member := range members {
				if member.AssistantID == input.AssistantID && member.Backend == input.AssistantBackend {
					joined = true
					input.ModelID, input.ThinkingEffort = member.ModelID, member.ThinkingEffort
					break
				}
			}
			if !joined {
				writeError(writer, http.StatusBadRequest, "shared_assistant_not_joined")
				return
			}
		}
		value, err := s.modules.Collaboration.CreateConversation(request.Context(), collaboration.Conversation{ID: id, ProjectID: input.ProjectID, Name: input.Name, Kind: kind, CreatorUserID: creatorUserID, RuntimeSessionID: runtimeSessionID, AssistantID: input.AssistantID, AssistantBackend: input.AssistantBackend, ModelID: input.ModelID, ThinkingEffort: input.ThinkingEffort}, user.ID)
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
		// Personal tasks are plain pointers to a creator-side runtime session;
		// assistant/model binding does not apply, but name/pin/hide metadata does.
		target, lookupErr := s.modules.Collaboration.ConversationForUser(request.Context(), input.ConversationID, user.ID, true)
		if lookupErr != nil {
			writeCollaborationError(writer, lookupErr)
			return
		}
		if target.Kind == "personal_task" && runtimeUpdate {
			writeError(writer, http.StatusBadRequest, "invalid_shared_conversation_update")
			return
		}
		var value collaboration.Conversation
		var err error
		if metadataUpdate {
			value, err = s.modules.Collaboration.UpdateConversationMetadata(request.Context(), input.ConversationID, user.ID, input.Name, input.Pinned, input.Hidden)
		} else {
			sharedMessageMu.Lock()
			defer sharedMessageMu.Unlock()
			current, lookupErr := s.modules.Collaboration.ConversationForUser(request.Context(), input.ConversationID, user.ID, true)
			if lookupErr != nil {
				writeCollaborationError(writer, lookupErr)
				return
			}
			modelID, effort := current.ModelID, current.ThinkingEffort
			if current.Role != "owner" {
				writeCollaborationError(writer, collaboration.ErrForbidden)
				return
			}
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
	case http.MethodDelete:
		var input struct {
			ConversationID string `json:"conversation_id"`
		}
		if !decodeJSON(request, &input, 16*1024) || strings.TrimSpace(input.ConversationID) == "" {
			writeError(writer, http.StatusBadRequest, "invalid_shared_conversation_delete")
			return
		}
		// Old loaded clients still use this route. Personal tasks have the same
		// durable deletion use case regardless of the caller's UI version.
		if target, lookupErr := s.modules.Collaboration.ConversationForUser(request.Context(), input.ConversationID, user.ID, true); lookupErr == nil && target.Kind == "personal_task" {
			s.deletePersonalTaskOperation(writer, request, user, target.ID)
			return
		} else if _, operationErr := s.modules.Collaboration.PersonalTaskOperation(request.Context(), input.ConversationID, user.ID); operationErr == nil {
			s.deletePersonalTaskOperation(writer, request, user, input.ConversationID)
			return
		}
		if err := s.modules.Collaboration.DeleteConversation(request.Context(), input.ConversationID, user.ID); err != nil {
			writeCollaborationError(writer, err)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
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
		ConversationID  string                  `json:"conversation_id"`
		ClientMessageID string                  `json:"client_message_id"`
		Body            string                  `json:"body"`
		Mentions        []collaboration.Mention `json:"mentions"`
		Attachments     []string                `json:"attachments"`
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
	sharedMessageMu.Lock()
	defer sharedMessageMu.Unlock()
	if input.ClientMessageID != "" {
		if !sharedOperationPattern.MatchString(input.ClientMessageID) {
			writeError(writer, 400, "invalid_message_id")
			return
		}
		id = "message_" + strconv.FormatInt(user.ID, 10) + "_" + input.ClientMessageID
		if existing, lookupErr := s.modules.Collaboration.MessageByID(request.Context(), id, input.ConversationID, user.ID); lookupErr == nil {
			if existing.Body != strings.TrimSpace(input.Body) || !slices.Equal(existing.Mentions, input.Mentions) || !slices.Equal(existing.Attachments, input.Attachments) {
				writeError(writer, 409, "shared_operation_conflict")
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"message": messageDTO(existing, user.ID), "ai_started": false, "ai_status": "already_sent"})
			return
		} else if !errors.Is(lookupErr, collaboration.ErrNotFound) {
			writeCollaborationError(writer, lookupErr)
			return
		}
	}
	conversation, err := s.modules.Collaboration.ConversationForUser(request.Context(), input.ConversationID, user.ID, true)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	members, err := s.modules.Collaboration.Members(request.Context(), conversation.ProjectID, user.ID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	for _, mention := range input.Mentions {
		valid := false
		for _, agent := range conversation.Assistants {
			if mention.Kind == "assistant" && mention.ID == agent.AssistantID {
				valid = true
			}
		}
		for _, member := range members {
			if mention.Kind == "member" && mention.ID == strconv.FormatInt(member.UserID, 10) {
				valid = true
			}
		}
		if !valid {
			writeError(writer, 400, "invalid_shared_mention")
			return
		}
	}
	value, err := s.modules.Collaboration.AddMessage(request.Context(), collaboration.Message{ID: id, Conversation: input.ConversationID, AuthorName: user.DisplayName, Kind: "user", Body: input.Body, Mentions: input.Mentions, Attachments: input.Attachments}, user.ID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	notified := map[int64]bool{}
	for _, mention := range input.Mentions {
		for _, member := range members {
			if mention.Kind == "member" && mention.ID == strconv.FormatInt(member.UserID, 10) && member.UserID != user.ID && !notified[member.UserID] {
				notified[member.UserID] = true
				s.publishNotification(request.Context(), contracts.NotificationInput{TargetSID: member.SID, Kind: "shared_mention", Title: user.DisplayName + " 在讨论中提到了你", Message: conversation.Name, DeepLink: "/?workagent=shared&project=" + conversation.ProjectID + "&discussion=" + conversation.ID + "&message=" + value.ID})
			}
		}
	}

	outcomes := s.startSharedAssistants(request.Context(), value, user.ID)
	started, reason, status := false, "", "not_requested"
	for _, outcome := range outcomes {
		if outcome.Status == "started" {
			started = true
		}
		if outcome.Reason != "" {
			reason = outcome.Reason
		}
	}
	if len(outcomes) > 0 {
		status = "blocked"
		if started {
			status = "started"
		} else if reason == "shared_run_busy" {
			status = "busy"
		}
	}
	s.sharedEvents.publish(value)
	writeJSON(writer, http.StatusCreated, map[string]any{"message": messageDTO(value, user.ID), "ai_started": started, "ai_status": status, "ai_reason": reason, "assistants": outcomes})
}

func conversationDTO(value collaboration.Conversation) sharedConversationDTO {
	return sharedConversationDTO{ID: value.ID, ProjectID: value.ProjectID, ProjectName: value.ProjectName, Role: value.Role, Name: value.Name, Kind: value.Kind, CreatorUserID: value.CreatorUserID, RuntimeSessionID: value.RuntimeSessionID, AssistantID: value.AssistantID, AssistantBackend: value.AssistantBackend, AssistantLocked: value.AssistantLocked, Assistants: value.Assistants, ModelID: value.ModelID, ThinkingEffort: value.ThinkingEffort, State: value.State, LastAIMessageSeq: value.LastAIMessageSeq, Pinned: value.Pinned, PinnedAt: value.PinnedAt, Hidden: value.Hidden, CreatedAt: value.CreatedAt.Format(time.RFC3339Nano), UpdatedAt: value.UpdatedAt.Format(time.RFC3339Nano)}
}

func messageDTO(value collaboration.Message, currentUserID int64) sharedMessageDTO {
	return sharedMessageDTO{Seq: value.Seq, ID: value.ID, Conversation: value.Conversation, AuthorUserID: value.AuthorUserID, AuthorName: value.AuthorName, AuthorAssistantID: value.AuthorAssistantID, Kind: value.Kind, Body: value.Body, Mentions: value.Mentions, Attachments: value.Attachments, CreatedAt: value.CreatedAt.Format(time.RFC3339Nano), IsCurrentUser: value.AuthorUserID != nil && *value.AuthorUserID == currentUserID}
}
