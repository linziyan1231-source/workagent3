package portal

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
	"workagent3/internal/auth"
	"workagent3/internal/publishedapps"
	"workagent3/internal/runtimeapi"
)

// PublishedAppsRuntimeHandler serves the employee-runtime channel used by the
// agent-facing publish tools. The runtime proxies its local requests here with
// the platform credential; apps are always scoped to the authenticated SID.
func (s *Server) PublishedAppsRuntimeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !runtimeapi.IsLoopbackRequest(r) {
			writeError(w, 403, "loopback_required")
			return
		}
		if r.Method != "POST" {
			writeError(w, 405, "method_not_allowed")
			return
		}
		if s.apps == nil {
			writeError(w, 503, "application_publishing_unavailable")
			return
		}
		var input runtimePublishInput
		decoder := json.NewDecoder(io.LimitReader(r.Body, 16*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			writeError(w, 400, "invalid_application")
			return
		}
		credential, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || !s.store.RuntimeRegistrationAuthorized(r.Context(), input.SID, credential) {
			writeError(w, 401, "registration_rejected")
			return
		}
		switch strings.TrimPrefix(r.URL.Path, "/internal/runtime/published-apps/") {
		case "list":
			s.runtimeListApplications(w, r, input.SID)
		case "publish":
			s.runtimePublishApplication(w, r, input)
		default:
			writeError(w, 404, "application_operation_not_found")
		}
	})
}

func (s *Server) runtimeListApplications(w http.ResponseWriter, r *http.Request, sid string) {
	rows, err := s.modules.PublishedApps.Store.List(r.Context(), sid)
	if err != nil {
		writeError(w, 500, "applications_failed")
		return
	}
	items := make([]appSummary, 0, len(rows))
	for _, a := range rows {
		items = append(items, s.appSummary(a))
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// runtimePublishInput is the JSON body of the internal publish/list calls.
type runtimePublishInput struct {
	SID            string   `json:"sid"`
	AppID          string   `json:"appId,omitempty"`
	WorkspaceID    string   `json:"workspaceId,omitempty"`
	Name           string   `json:"name,omitempty"`
	Kind           string   `json:"kind,omitempty"`
	Entry          string   `json:"entry,omitempty"`
	AllowedOrigins []string `json:"allowedOrigins,omitempty"`
	Access         string   `json:"access,omitempty"`
	ValidDays      int      `json:"validDays,omitempty"`
}

// runtimePublishApplication creates (or reuses) the app record, snapshots the
// workspace entry directory as a new version and publishes it in one step.
func (s *Server) runtimePublishApplication(w http.ResponseWriter, r *http.Request, input runtimePublishInput) {
	owner, err := s.store.UserBySID(r.Context(), input.SID)
	if err != nil || owner.Disabled || owner.Offboarded {
		writeError(w, 403, "application_owner_required")
		return
	}
	if input.WorkspaceID == "" || input.Name == "" {
		writeError(w, 400, "invalid_application")
		return
	}
	kind := input.Kind
	if kind == "" {
		kind = "static"
	}
	entry := input.Entry
	if entry == "" {
		entry = "index.html"
	}
	access := input.Access
	if access == "" {
		access = publishedapps.AccessAuthenticated
	}
	if !publishedapps.ValidAccess(access) {
		writeError(w, 400, "invalid_application")
		return
	}
	if input.ValidDays < 0 || input.ValidDays > 3650 {
		writeError(w, 400, "invalid_application")
		return
	}
	validity := publishedapps.DefaultValidity
	if input.ValidDays > 0 {
		validity = time.Duration(input.ValidDays) * 24 * time.Hour
	}
	apps := s.modules.PublishedApps.Store
	var a publishedapps.App
	if input.AppID != "" {
		a, err = apps.Get(r.Context(), input.AppID)
		if err != nil {
			writeError(w, 404, "application_not_found")
			return
		}
		if a.OwnerSID != input.SID {
			writeError(w, 403, "application_owner_required")
			return
		}
		if input.WorkspaceID != a.WorkspaceID {
			writeError(w, 400, "application_workspace_mismatch")
			return
		}
	} else {
		rows, err := apps.List(r.Context(), input.SID)
		if err != nil {
			writeError(w, 500, "applications_failed")
			return
		}
		found := false
		for _, row := range rows {
			if row.WorkspaceID == input.WorkspaceID && row.Name == input.Name {
				a = row
				found = true
				break
			}
		}
		if !found {
			a, err = apps.Create(r.Context(), publishedapps.App{OwnerID: owner.ID, OwnerSID: input.SID, WorkspaceID: input.WorkspaceID, Name: input.Name, Kind: kind, Entry: entry, AllowedOrigins: input.AllowedOrigins})
			if err != nil {
				writeError(w, 400, err.Error())
				return
			}
		}
	}
	a.Name = input.Name
	a.Kind = kind
	a.Entry = entry
	a.AllowedOrigins = input.AllowedOrigins
	if err = s.apps.listen(a); err != nil {
		writeError(w, 503, "application_port_unavailable")
		return
	}
	version, err := auth.RandomToken(18)
	if err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	snapshot := map[string]any{"workspaceId": a.WorkspaceID, "kind": a.Kind, "entry": a.Entry, "allowedOrigins": a.AllowedOrigins, "version": version, "preview": false}
	if err = s.appRuntimeOperation(r.Context(), a, "versions", snapshot); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	a.Versions = append(a.Versions, version)
	a.Version = version
	a.Access = access
	a.Enabled = true
	a.ExpiresAt = time.Now().Add(validity)
	if access == publishedapps.AccessPassword && a.Password == "" {
		if a.Password, err = publishedapps.RandomAccessCode(); err != nil {
			writeError(w, 500, "internal_error")
			return
		}
	}
	if access == publishedapps.AccessToken && a.ShareToken == "" {
		if a.ShareToken, err = auth.RandomToken(18); err != nil {
			writeError(w, 500, "internal_error")
			return
		}
	}
	if access != publishedapps.AccessPassword {
		a.Password = ""
	}
	if access != publishedapps.AccessToken {
		a.ShareToken = ""
	}
	updated, err := apps.Update(r.Context(), a, a.Revision)
	s.recordBusinessEvent(r.Context(), owner.Username, "application.publish", a.ID, err, nil)
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	s.apps.disconnect(a.ID)
	writeJSON(w, 200, s.appSummary(updated))
}
