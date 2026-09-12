package portal

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/winutil"
)

func (s *Server) PublishedAppsNetworkHandler() http.Handler {
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
		var input struct {
			Operation   string `json:"operation"`
			SID         string `json:"sid"`
			AppID       string `json:"appId"`
			Version     string `json:"version"`
			BackendPort int    `json:"backendPort"`
			BrokerPort  int    `json:"brokerPort"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 4096))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			writeError(w, 400, "invalid_application_network")
			return
		}
		credential, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || !s.store.RuntimeRegistrationAuthorized(r.Context(), input.SID, credential) {
			writeError(w, 401, "registration_rejected")
			return
		}
		app, err := s.modules.PublishedApps.Store.Get(r.Context(), input.AppID)
		if err != nil || app.OwnerSID != input.SID {
			writeError(w, 403, "application_owner_required")
			return
		}
		if input.Operation == "disable" {
			if _, err = winutil.AppContainerName(input.AppID, input.Version); err != nil {
				writeError(w, 400, "invalid_application_network")
				return
			}
			err = winutil.DisableAppNetwork(winutil.AppNetworkRule{AppID: input.AppID, Version: input.Version})
			if err != nil {
				writeError(w, 503, "application_network_cleanup_failed")
				return
			}
			writeJSON(w, 200, map[string]bool{"disabled": true})
			return
		}
		if input.Operation != "" && input.Operation != "enable" {
			writeError(w, 400, "invalid_application_network")
			return
		}
		if !s.applicationOwnerAllowed(r.Context(), app) {
			writeError(w, 403, "application_owner_disabled")
			return
		}
		allowed := input.Version != "" && (input.Version == app.PreviewVersion || input.Version == app.Version)
		for _, version := range app.Versions {
			if version == input.Version {
				allowed = true
			}
		}
		s.apps.mu.Lock()
		allowed = allowed || time.Now().Before(s.apps.provisioning[input.AppID+"/"+input.Version])
		s.apps.mu.Unlock()
		if !allowed {
			writeError(w, 403, "application_version_not_authorized")
			return
		}
		executable, err := os.Executable()
		if err != nil || !filepath.IsAbs(s.apps.config.EmployeeRoot) {
			writeError(w, 503, "application_network_unavailable")
			return
		}
		brokerConfig := filepath.Join(s.apps.config.EmployeeRoot, input.SID, "published-apps", input.AppID, "versions", input.Version, "run", "broker.json")
		if err = winutil.VerifyPublishedAppBroker(input.BrokerPort, input.SID, filepath.Join(filepath.Dir(executable), "userhost.exe"), brokerConfig); err != nil {
			writeError(w, 403, "application_broker_rejected")
			return
		}
		sid, err := winutil.EnableAppNetwork(winutil.AppNetworkRule{AppID: input.AppID, Version: input.Version, BackendPort: input.BackendPort, BrokerPort: input.BrokerPort})
		s.recordBusinessEvent(r.Context(), input.SID, "application.network", input.AppID, err, nil)
		if err != nil {
			writeError(w, 503, "application_network_unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"packageSid": sid})
	})
}
