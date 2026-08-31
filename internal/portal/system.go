package portal

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"workagent3/internal/buildinfo"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

func (s *Server) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"status": "healthy", "build": buildinfo.Current()})
}

func (s *Server) systemStatus(writer http.ResponseWriter, request *http.Request, user store.User) {
	writeJSON(writer, http.StatusOK, s.collectSystemStatus(request.Context(), user))
}

func (s *Server) collectSystemStatus(ctx context.Context, user store.User) contracts.SystemStatus {
	components := []contracts.ComponentStatus{{ID: "portal", Status: "healthy"}}
	components = append(components, configuredStatus("notifications", s.modules.Notifications != nil), configuredStatus("audit", s.modules.Audit != nil))
	endpoint, err := s.runtimes.Resolve(ctx, user.SID)
	if err != nil {
		components = append(components, contracts.ComponentStatus{ID: "userhost", Status: "unavailable"}, contracts.ComponentStatus{ID: "harness", Status: "unknown"})
		return contracts.SystemStatus{Build: buildinfo.Current(), Components: components}
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/v1/system/status"})
	downstream, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	downstream.Header.Set("Authorization", "Bearer "+endpoint.Token)
	setCorrelationHeader(downstream)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(downstream)
	if err != nil {
		components = append(components, contracts.ComponentStatus{ID: "userhost", Status: "unhealthy"}, contracts.ComponentStatus{ID: "harness", Status: "unknown"})
		return contracts.SystemStatus{Build: buildinfo.Current(), Components: components}
	}
	defer response.Body.Close()
	var runtimeStatus struct {
		Components []contracts.ComponentStatus `json:"components"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 32*1024))
	if response.StatusCode != http.StatusOK || decoder.Decode(&runtimeStatus) != nil || len(runtimeStatus.Components) == 0 {
		components = append(components, contracts.ComponentStatus{ID: "userhost", Status: "unhealthy"}, contracts.ComponentStatus{ID: "harness", Status: "unknown"})
	} else {
		components = append(components, runtimeStatus.Components...)
	}
	return contracts.SystemStatus{Build: buildinfo.Current(), Components: components}
}

func (s *Server) systemDiagnostics(writer http.ResponseWriter, request *http.Request, user store.User) {
	manifest := struct {
		SchemaVersion int                    `json:"schema_version"`
		GeneratedAt   time.Time              `json:"generated_at"`
		Scope         string                 `json:"scope"`
		CorrelationID string                 `json:"correlation_id"`
		System        contracts.SystemStatus `json:"system"`
	}{SchemaVersion: 1, GeneratedAt: s.now().UTC(), Scope: "authenticated-user-redacted", CorrelationID: CorrelationID(request.Context()), System: s.collectSystemStatus(request.Context(), user)}
	writer.Header().Set("Content-Disposition", `attachment; filename="workagent-diagnostics.zip"`)
	writer.Header().Set("Content-Type", "application/zip")
	archive := zip.NewWriter(writer)
	defer archive.Close()
	header := &zip.FileHeader{Name: "manifest.json", Method: zip.Deflate}
	header.SetMode(0o600)
	header.Modified = s.now().UTC()
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return
	}
	_ = json.NewEncoder(entry).Encode(manifest)
}

func (s *Server) restartRuntime(writer http.ResponseWriter, request *http.Request, user store.User) {
	endpoint, err := s.runtimes.Resolve(request.Context(), user.SID)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "runtime_unavailable")
		return
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/v1/system/restart"})
	downstream, _ := http.NewRequestWithContext(request.Context(), http.MethodPost, target.String(), nil)
	downstream.Header.Set("Authorization", "Bearer "+endpoint.Token)
	setCorrelationHeader(downstream)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(downstream)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "runtime_restart_failed")
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		writeError(writer, http.StatusBadGateway, "runtime_restart_failed")
		return
	}
	writeJSON(writer, http.StatusAccepted, contracts.RuntimeRestart{ReconnectAfterMS: 4000})
}

func configuredStatus(id string, configured bool) contracts.ComponentStatus {
	if configured {
		return contracts.ComponentStatus{ID: id, Status: "healthy"}
	}
	return contracts.ComponentStatus{ID: id, Status: "disabled"}
}
