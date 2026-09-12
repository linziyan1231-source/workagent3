package portal

import (
	"net/http"
	"strings"
	"workagent3/internal/runtimeapi"
)

// SharedChannelHandler is deliberately separate from browser routes: an IM
// runtime authenticates its employee SID and never accepts browser identity.
func (s *Server) SharedChannelHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !runtimeapi.IsLoopbackRequest(r) {
			writeError(w, 403, "loopback_required")
			return
		}
		if r.Method != http.MethodPost {
			writeError(w, 405, "method_not_allowed")
			return
		}
		var input struct {
			SID            string `json:"sid"`
			Action         string `json:"action"`
			ConversationID string `json:"conversationId"`
			After          *int64 `json:"after"`
			Head           int64  `json:"head"`
			Before         int64  `json:"before"`
			Limit          int    `json:"limit"`
		}
		if !decodeJSON(r, &input, 256*1024) {
			writeError(w, 400, "invalid_request")
			return
		}
		credential, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !s.store.RuntimeRegistrationAuthorized(r.Context(), input.SID, credential) {
			writeError(w, 401, "registration_rejected")
			return
		}
		user, err := s.store.UserBySID(r.Context(), input.SID)
		if err != nil || user.Disabled {
			writeError(w, 403, "employee_unavailable")
			return
		}
		if s.modules.Collaboration == nil {
			writeError(w, 503, "collaboration_unavailable")
			return
		}
		if input.Action == "feed" {
			if input.After == nil {
				head, err := s.modules.Collaboration.ChannelHead(r.Context())
				if err != nil {
					writeError(w, 500, "shared_history_failed")
					return
				}
				writeJSON(w, 200, map[string]any{"cursor": head, "messages": []any{}})
				return
			}
			messages, err := s.modules.Collaboration.ListMessagesForUserAfter(r.Context(), user.ID, *input.After, 100)
			if err != nil {
				writeCollaborationError(w, err)
				return
			}
			cursor := *input.After
			out := []sharedMessageDTO{}
			for _, message := range messages {
				cursor = message.Seq
				if message.Kind == "assistant" {
					out = append(out, messageDTO(message, user.ID))
				}
			}
			writeJSON(w, 200, map[string]any{"cursor": cursor, "messages": out})
			return
		}
		conversation, err := s.modules.Collaboration.ConversationForUser(r.Context(), input.ConversationID, user.ID, true)
		if err != nil {
			writeCollaborationError(w, err)
			return
		}
		if conversation.Kind != "discussion" {
			writeError(w, 400, "not_a_discussion")
			return
		}
		switch input.Action {
		case "access":
			project, err := s.modules.Collaboration.ProjectForUser(r.Context(), conversation.ProjectID, user.ID, true)
			if err != nil {
				writeCollaborationError(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"conversation": conversationDTO(conversation), "project": project})
		case "history":
			if input.Limit < 1 || input.Limit > 100 {
				writeError(w, 400, "invalid_history_limit")
				return
			}
			messages, head, err := s.modules.Collaboration.ChannelHistory(r.Context(), conversation.ID, user.ID, input.Head, input.Before, input.Limit)
			if err != nil {
				writeCollaborationError(w, err)
				return
			}
			out := []sharedMessageDTO{}
			for _, m := range messages {
				out = append(out, messageDTO(m, user.ID))
			}
			writeJSON(w, 200, map[string]any{"messages": out, "head": head, "before": input.Before})
		default:
			writeError(w, 400, "unsupported_collaboration_action")
		}
	})
}
