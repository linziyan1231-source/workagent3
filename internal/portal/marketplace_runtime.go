package portal

import (
	"net/http"
	"strings"
	"workagent3/internal/runtimeapi"
)

// Runtime admission also covers IM/WebSocket turns, which do not pass through a browser POST.
func (s *Server) MarketRuntimeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !runtimeapi.IsLoopbackRequest(r) {
			writeError(w, 403, "loopback_required")
			return
		}
		var input struct {
			SID         string `json:"sid"`
			ProjectID   string `json:"projectId"`
			WorkspaceID string `json:"workspaceId"`
		}
		if r.Method != "POST" || !decodeJSON(r, &input, 4096) {
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
		if s.modules.Marketplace == nil {
			writeJSON(w, 200, map[string]any{})
			return
		}
		actions, err := s.modules.Marketplace.Actions(r.Context())
		if err != nil {
			marketError(w, err)
			return
		}
		for _, a := range actions {
			for _, t := range a.Targets {
				if t.SID == user.SID && t.State == "pending" {
					go s.processMarketActions()
					writeError(w, 409, "market_security_update_pending")
					return
				}
			}
		}
		if input.ProjectID == "" && input.WorkspaceID == "" {
			writeJSON(w, 200, map[string]any{})
			return
		}
		projectKey := personalSubscriptionKey(user.SID, input.WorkspaceID)
		if input.ProjectID != "" {
			if s.modules.Collaboration == nil {
				writeError(w, 503, "collaboration_unavailable")
				return
			}
			project, err := s.modules.Collaboration.ProjectForUser(r.Context(), input.ProjectID, user.ID, true)
			if err != nil {
				writeCollaborationError(w, err)
				return
			}
			projectKey = project.ID
		}
		s.modules.Marketplace.InstallMu.Lock()
		defer s.modules.Marketplace.InstallMu.Unlock()
		capabilities, err := s.resolveProjectCapabilities(r.Context(), projectKey, user)
		if err != nil {
			marketError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"capabilities": capabilities})
	})
}
