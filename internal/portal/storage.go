package portal

import (
	"context"
	"net/http"
	"net/url"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

type StoragePort interface {
	StorageUsage(context.Context, string) (contracts.StorageUsage, error)
	SetStorageLimits(context.Context, string, contracts.StorageLimits) (contracts.StorageUsage, error)
}

func (c *EmployeeManagerClient) StorageUsage(ctx context.Context, sid string) (contracts.StorageUsage, error) {
	var value contracts.StorageUsage
	err := c.call(ctx, http.MethodGet, "/v1/storage/"+url.PathEscape(sid), nil, &value)
	return value, err
}
func (c *EmployeeManagerClient) SetStorageLimits(ctx context.Context, sid string, limits contracts.StorageLimits) (contracts.StorageUsage, error) {
	var value contracts.StorageUsage
	err := c.call(ctx, http.MethodPut, "/v1/storage/"+url.PathEscape(sid), limits, &value)
	return value, err
}

func (s *Server) storageUsage(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Storage == nil {
		writeError(w, 503, "storage_unavailable")
		return
	}
	value, err := s.modules.Storage.StorageUsage(r.Context(), user.SID)
	if err != nil {
		writeError(w, 503, "storage_unavailable")
		return
	}
	writeJSON(w, 200, value)
}
func (s *Server) adminStorage(w http.ResponseWriter, r *http.Request, _ store.User) {
	if s.modules.Storage == nil {
		writeError(w, 503, "storage_unavailable")
		return
	}
	var input struct {
		Username string                  `json:"username"`
		Limits   contracts.StorageLimits `json:"limits"`
	}
	if r.Method == http.MethodGet {
		input.Username = r.URL.Query().Get("username")
	} else if !decodeJSON(r, &input, 4096) {
		writeError(w, 400, "invalid_storage_limits")
		return
	}
	user, err := s.store.UserByUsername(r.Context(), input.Username)
	if err != nil {
		writeError(w, 404, "employee_not_found")
		return
	}
	if r.Method == http.MethodGet {
		value, err := s.modules.Storage.StorageUsage(r.Context(), user.SID)
		if err != nil {
			writeError(w, 503, "storage_unavailable")
			return
		}
		writeJSON(w, 200, value)
		return
	}
	value, err := s.modules.Storage.SetStorageLimits(r.Context(), user.SID, input.Limits)
	if err != nil {
		writeError(w, 400, "storage_update_failed")
		return
	}
	writeJSON(w, 200, value)
}
