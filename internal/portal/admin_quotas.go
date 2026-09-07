package portal

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"
	"workagent3/internal/quota"
	"workagent3/internal/store"
)

type QuotaManagementPort interface {
	ManagedBudgets(context.Context, string, time.Time) ([]quota.ManagedBudget, error)
	AdjustBudget(context.Context, string, string, string, int64, time.Time) error
}

func (s *Server) adminQuotas(w http.ResponseWriter, r *http.Request, actor store.User) {
	if !actor.Admin {
		writeError(w, 403, "administrator_required")
		return
	}
	management, ok := s.modules.Quota.(QuotaManagementPort)
	if !ok {
		writeError(w, 503, "quota_unavailable")
		return
	}
	var input struct {
		Username   string `json:"username"`
		ModelID    string `json:"modelId"`
		Mode       string `json:"mode"`
		LimitUnits *int64 `json:"limitUnits"`
	}
	if r.Method == http.MethodGet {
		input.Username = r.URL.Query().Get("username")
	} else if !decodeJSON(r, &input, 8*1024) || input.ModelID == "" || input.LimitUnits == nil || *input.LimitUnits < 0 || *input.LimitUnits > 9007199254740991 || (input.Mode != "temporary" && input.Mode != "permanent" && input.Mode != "restore") {
		writeError(w, 400, "invalid_quota_adjustment")
		return
	}
	target, err := s.store.UserByUsername(r.Context(), input.Username)
	if err != nil {
		writeError(w, 404, "employee_not_found")
		return
	}
	if r.Method == http.MethodPost {
		err = management.AdjustBudget(r.Context(), target.SID, input.ModelID, input.Mode, *input.LimitUnits, s.now())
		s.recordBusinessEvent(r.Context(), actor.SID, "quota.adjust", target.SID, err, map[string]string{"modelId": input.ModelID, "mode": input.Mode, "limitUnits": strconv.FormatInt(*input.LimitUnits, 10)})
		if errors.Is(err, quota.ErrBudgetNotConfigured) {
			writeError(w, 404, "quota_not_configured")
			return
		}
		if err != nil {
			writeError(w, 500, "quota_adjust_failed")
			return
		}
	}
	budgets, err := management.ManagedBudgets(r.Context(), target.SID, s.now())
	if err != nil {
		writeError(w, 500, "quota_failed")
		return
	}
	writeJSON(w, 200, map[string]any{"budgets": budgets})
}
