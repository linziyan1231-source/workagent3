package portal

import (
	"errors"
	"net/http"
	"strings"
	"workagent3/internal/acpcatalog"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func (s *Server) adminAcpCatalog(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.AcpCatalog == nil {
		writeError(w, 503, "acp_catalog_unavailable")
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"entries": s.modules.AcpCatalog.Revisions()})
		return
	}
	var selection acpcatalog.Selection
	if !decodeJSON(r, &selection, 4096) {
		writeError(w, 400, "invalid_acp_selection")
		return
	}
	err := s.modules.AcpCatalog.Select(r.PathValue("id"), selection)
	s.recordBusinessEvent(r.Context(), user.Username, "acp.catalog.select", r.PathValue("id"), err, map[string]string{"revision": selection.Revision})
	if err != nil {
		writeAcpError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"success": true})
}

func writeAcpError(w http.ResponseWriter, err error) {
	status := 503
	if errors.Is(err, acpcatalog.ErrNotFound) {
		status = 404
	}
	if errors.Is(err, acpcatalog.ErrDisabled) {
		status = 409
	}
	code := "acp_catalog_unavailable"
	if status != 503 {
		code = err.Error()
	}
	writeError(w, status, code)
}

// Only the owning employee Runtime may obtain approved executable definitions.
func (s *Server) AcpCatalogRuntimeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !runtimeapi.IsLoopbackRequest(r) {
			writeError(w, 403, "loopback_required")
			return
		}
		var input struct {
			SID      string `json:"sid"`
			ID       string `json:"id"`
			Revision string `json:"revision"`
		}
		if r.Method != http.MethodPost || !decodeJSON(r, &input, 4096) {
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
		if s.modules.AcpCatalog == nil {
			writeJSON(w, 200, map[string]any{"entries": []acpcatalog.Entry{}})
			return
		}
		if input.ID == "" {
			writeJSON(w, 200, map[string]any{"entries": s.modules.AcpCatalog.List()})
			return
		}
		entry, err := s.modules.AcpCatalog.Resolve(input.ID, input.Revision)
		if err != nil {
			writeAcpError(w, err)
			return
		}
		writeJSON(w, 200, entry)
	})
}
