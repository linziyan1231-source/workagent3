package portal

import (
	"context"
	"net/http"
	"time"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

type dollarBillingPort interface {
	DollarBudgets(context.Context, string) ([]contracts.DollarBudget, error)
	DollarUsage(context.Context, string, time.Time, time.Time) ([]contracts.DollarUsageRow, error)
}

func (s *Server) dollarBudgets(w http.ResponseWriter, r *http.Request, actor store.User) {
	billing, ok := s.modules.Quota.(dollarBillingPort)
	if !ok {
		writeError(w, 503, "quota_unavailable")
		return
	}
	sid := actor.SID
	if username := r.URL.Query().Get("username"); username != "" {
		if !actor.Admin {
			writeError(w, 403, "administrator_required")
			return
		}
		target, err := s.store.UserByUsername(r.Context(), username)
		if err != nil {
			writeError(w, 404, "employee_not_found")
			return
		}
		sid = target.SID
	}
	budgets, err := billing.DollarBudgets(r.Context(), sid)
	if err != nil {
		writeError(w, 503, "quota_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"budgets": budgets})
}

func (s *Server) dollarUsage(w http.ResponseWriter, r *http.Request, actor store.User) {
	if !actor.Admin {
		writeError(w, 403, "administrator_required")
		return
	}
	billing, ok := s.modules.Quota.(dollarBillingPort)
	if !ok {
		writeError(w, 503, "quota_unavailable")
		return
	}
	from, e1 := time.Parse(time.RFC3339, r.URL.Query().Get("from"))
	to, e2 := time.Parse(time.RFC3339, r.URL.Query().Get("to"))
	if e1 != nil || e2 != nil || !from.Before(to) {
		writeError(w, 400, "invalid_usage_interval")
		return
	}
	sid := ""
	if username := r.URL.Query().Get("username"); username != "" {
		target, err := s.store.UserByUsername(r.Context(), username)
		if err != nil {
			writeError(w, 404, "employee_not_found")
			return
		}
		sid = target.SID
	}
	rows, err := billing.DollarUsage(r.Context(), sid, from, to)
	if err != nil {
		writeError(w, 503, "quota_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"rows": rows, "from": from, "to": to})
}
