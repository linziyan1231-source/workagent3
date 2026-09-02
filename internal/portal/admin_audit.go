package portal

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

// adminAuditEvents and adminAuditExport expose the business audit log to
// Portal administrators. Both share the same filters (actor, action, target,
// RFC3339 from/to, limit) and pass results through export redaction; the
// export variant returns the same indented JSON array as cmd/audit-export.
// They check the admin flag directly rather than requireAdmin, which is
// coupled to the Employee Manager module being configured.
func (s *Server) adminAuditEvents(writer http.ResponseWriter, request *http.Request, user store.User) {
	if !user.Admin {
		writeError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	if s.modules.Audit == nil {
		writeError(writer, http.StatusServiceUnavailable, "audit_unavailable")
		return
	}
	query, ok := parseAuditQuery(writer, request)
	if !ok {
		return
	}
	events, err := s.modules.Audit.List(request.Context(), query)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "audit_query_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "events": audit.RedactEvents(events)})
}

func (s *Server) adminAuditExport(writer http.ResponseWriter, request *http.Request, user store.User) {
	if !user.Admin {
		writeError(writer, http.StatusForbidden, "administrator_required")
		return
	}
	if s.modules.Audit == nil {
		writeError(writer, http.StatusServiceUnavailable, "audit_unavailable")
		return
	}
	query, ok := parseAuditQuery(writer, request)
	if !ok {
		return
	}
	events, err := s.modules.Audit.List(request.Context(), query)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "audit_query_failed")
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Content-Disposition", `attachment; filename="audit-export-`+time.Now().UTC().Format("20060102T150405Z")+`.json"`)
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(audit.RedactEvents(events))
}

func parseAuditQuery(writer http.ResponseWriter, request *http.Request) (contracts.AuditQuery, bool) {
	parameters := request.URL.Query()
	query := contracts.AuditQuery{
		Actor: parameters.Get("actor"), Action: parameters.Get("action"),
		Target: parameters.Get("target"), CorrelationID: parameters.Get("correlation_id"),
	}
	var err error
	if query.From, err = parseAuditBound(parameters.Get("from")); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_audit_filter")
		return contracts.AuditQuery{}, false
	}
	if query.To, err = parseAuditBound(parameters.Get("to")); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_audit_filter")
		return contracts.AuditQuery{}, false
	}
	if raw := parameters.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 1000 {
			writeError(writer, http.StatusBadRequest, "invalid_audit_filter")
			return contracts.AuditQuery{}, false
		}
		query.Limit = limit
	}
	return query, true
}

func parseAuditBound(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339, value)
}
