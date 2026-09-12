package portal

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"workagent3/internal/chatforward"
	"workagent3/internal/store"
)

type ChatGPTProPort interface {
	Usage(context.Context, string, time.Time) (chatforward.Usage, error)
	Sends(context.Context, string, time.Time) ([]chatforward.Send, error)
	SetLimit(context.Context, string, int) error
	Resolve(context.Context, string, string, string, string, string, time.Time) error
}

func (s *Server) chatGPTProUsage(w http.ResponseWriter, r *http.Request, actor store.User) {
	if s.modules.ChatGPTPro == nil {
		writeError(w, 503, "chatgpt_unavailable")
		return
	}
	target := actor
	if username := r.URL.Query().Get("username"); username != "" {
		if !actor.Admin {
			writeError(w, 403, "administrator_required")
			return
		}
		var err error
		target, err = s.store.UserByUsername(r.Context(), username)
		if err != nil {
			writeError(w, 404, "employee_not_found")
			return
		}
	}
	quota, err := s.modules.ChatGPTPro.Usage(r.Context(), target.SID, s.now())
	if err != nil {
		writeError(w, 500, "quota_unavailable")
		return
	}
	sends, err := s.modules.ChatGPTPro.Sends(r.Context(), target.SID, s.now())
	if err != nil {
		writeError(w, 500, "quota_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"quota": quota, "sends": sends})
}

func (s *Server) adminChatGPTPro(w http.ResponseWriter, r *http.Request, actor store.User) {
	if !actor.Admin {
		writeError(w, 403, "administrator_required")
		return
	}
	if s.modules.ChatGPTPro == nil {
		writeError(w, 503, "chatgpt_unavailable")
		return
	}
	var input struct {
		Username  string `json:"username"`
		Limit     *int   `json:"limit"`
		LogicalID string `json:"logical_id"`
		Decision  string `json:"decision"`
		Reason    string `json:"reason"`
	}
	if !decodeJSON(r, &input, 4096) {
		writeError(w, 400, "invalid_request")
		return
	}
	target, err := s.store.UserByUsername(r.Context(), input.Username)
	if err != nil {
		writeError(w, 404, "employee_not_found")
		return
	}
	metadata := map[string]string{}
	action := "chatgpt_pro.limit"
	if input.Limit != nil {
		if *input.Limit < 0 || *input.Limit > 10000 || input.LogicalID != "" {
			writeError(w, 400, "invalid_quota_adjustment")
			return
		}
		metadata["limit"] = strconv.Itoa(*input.Limit)
		err = s.modules.ChatGPTPro.SetLimit(r.Context(), target.SID, *input.Limit)
	} else {
		action = "chatgpt_pro.resolve"
		metadata["logical_id"] = input.LogicalID
		metadata["decision"] = input.Decision
		if input.Reason == "" || len(input.Reason) > 500 || (input.Decision != "dispatched" && input.Decision != "cancelled") {
			writeError(w, 400, "invalid_resolution")
			return
		}
		err = s.modules.ChatGPTPro.Resolve(r.Context(), target.SID, input.LogicalID, input.Decision, actor.SID, input.Reason, s.now())
	}
	s.recordBusinessEvent(r.Context(), actor.SID, action, target.SID, err, metadata)
	if errors.Is(err, chatforward.ErrConflict) {
		writeError(w, 409, "chatgpt_resolution_conflict")
		return
	}
	if err != nil {
		writeError(w, 500, "quota_unavailable")
		return
	}
	r.URL.RawQuery = "username=" + input.Username
	s.chatGPTProUsage(w, r, actor)
}
