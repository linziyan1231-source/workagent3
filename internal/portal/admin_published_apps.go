package portal

import (
	"net/http"
	"sort"
	"strconv"
	"workagent3/internal/store"
)

// adminPublishedAppSettings exposes the runtime-adjustable application
// publishing network policy: the dedicated port range (must match the cloud
// firewall) and the per-employee public-port quota. Changing the range
// remaps existing applications and rebinds their listeners on demand.
func (s *Server) adminPublishedAppSettings(w http.ResponseWriter, r *http.Request, actor store.User) {
	apps := s.modules.PublishedApps.Store
	if apps == nil {
		writeError(w, http.StatusServiceUnavailable, "application_publishing_unavailable")
		return
	}
	if r.Method == http.MethodPut {
		var input struct {
			FirstPort        int `json:"firstPort"`
			LastPort         int `json:"lastPort"`
			MaxEmployeePorts int `json:"maxEmployeePorts"`
		}
		if !decodeJSON(r, &input, 8*1024) || input.FirstPort < 1024 || input.LastPort > 65535 || input.LastPort-input.FirstPort < 1 || input.MaxEmployeePorts < 1 {
			writeError(w, http.StatusBadRequest, "invalid_application_settings")
			return
		}
		first, last, max := apps.Settings()
		if input.FirstPort != first || input.LastPort != last {
			changed, err := apps.SetRange(r.Context(), input.FirstPort, input.LastPort)
			s.recordBusinessEvent(r.Context(), actor.Username, "application.settings.range", "", err, map[string]string{"firstPort": strconv.Itoa(input.FirstPort), "lastPort": strconv.Itoa(input.LastPort)})
			if err != nil {
				writeError(w, http.StatusUnprocessableEntity, err.Error())
				return
			}
			for _, id := range changed {
				s.apps.unlisten(id)
			}
		}
		if input.MaxEmployeePorts != max {
			err := apps.SetMaxEmployeePorts(r.Context(), input.MaxEmployeePorts)
			s.recordBusinessEvent(r.Context(), actor.Username, "application.settings.quota", "", err, map[string]string{"maxEmployeePorts": strconv.Itoa(input.MaxEmployeePorts)})
			if err != nil {
				writeError(w, http.StatusUnprocessableEntity, err.Error())
				return
			}
		}
	}
	first, last, max := apps.Settings()
	used, byOwner, err := apps.PortUsage(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "application_settings_failed")
		return
	}
	usage := []map[string]any{}
	for sid, ports := range byOwner {
		entry := map[string]any{"sid": sid, "ports": ports}
		if user, uerr := s.store.UserBySID(r.Context(), sid); uerr == nil {
			entry["username"] = user.Username
		}
		usage = append(usage, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"firstPort":        first,
		"lastPort":         last,
		"maxEmployeePorts": max,
		"totalPorts":       last - first + 1,
		"usedPorts":        used,
		"employeeUsage":    usage,
	})
}

// adminPublishedApps lists every published application with the owner name and
// share link so administrators can review the pages employees exposed. Newest
// first. Deletion stays with the owner; admins can only unpublish.
func (s *Server) adminPublishedApps(w http.ResponseWriter, r *http.Request, _ store.User) {
	apps := s.modules.PublishedApps.Store
	if apps == nil {
		writeError(w, http.StatusServiceUnavailable, "application_publishing_unavailable")
		return
	}
	items, err := apps.List(r.Context(), "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "application_list_failed")
		return
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	entries := []map[string]any{}
	for _, a := range items {
		summary := s.appSummary(a)
		entry := map[string]any{
			"id":        a.ID,
			"name":      a.Name,
			"kind":      a.Kind,
			"access":    a.Access,
			"url":       summary.URL,
			"shareUrl":  summary.ShareURL,
			"enabled":   a.Enabled,
			"createdAt": a.CreatedAt,
		}
		if user, uerr := s.store.UserBySID(r.Context(), a.OwnerSID); uerr == nil {
			entry["username"] = user.Username
		} else {
			entry["username"] = a.OwnerSID
		}
		entries = append(entries, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"apps": entries})
}

// adminUnpublishPublishedApp takes an employee's published page offline using
// the same stop path as the owner unpublish, audited under the admin's name.
func (s *Server) adminUnpublishPublishedApp(w http.ResponseWriter, r *http.Request, actor store.User) {
	apps := s.modules.PublishedApps.Store
	if apps == nil {
		writeError(w, http.StatusServiceUnavailable, "application_publishing_unavailable")
		return
	}
	a, err := apps.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "application_not_found")
		return
	}
	updated, status, message, stopErr := s.stopApp(r.Context(), a, a.Revision)
	if status == http.StatusOK || stopErr != nil {
		s.recordBusinessEvent(r.Context(), actor.Username, "application.unpublish", a.ID, stopErr, nil)
	}
	if status != http.StatusOK {
		writeError(w, status, message)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}
