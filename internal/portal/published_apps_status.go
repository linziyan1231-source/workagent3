package portal

import (
	"io"
	"net/http"
	"net/url"
	"time"
	"workagent3/internal/store"
)

func (s *Server) applicationStatus(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.apps == nil {
		writeError(w, 503, "application_publishing_unavailable")
		return
	}
	app, err := s.apps.config.Store.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "application_not_found")
		return
	}
	if app.OwnerSID != user.SID {
		writeError(w, 403, "application_owner_required")
		return
	}
	if tracker, ok := s.runtimes.(interface{ BeginRequest(string) (func(), error) }); ok {
		done, e := tracker.BeginRequest(user.SID)
		if e != nil {
			writeError(w, 503, "application_unavailable")
			return
		}
		defer done()
	}
	endpoint, err := s.runtimes.Resolve(r.Context(), user.SID)
	if err != nil {
		writeError(w, 503, "application_unavailable")
		return
	}
	version := app.Version
	if r.URL.Query().Get("preview") == "true" {
		version = app.PreviewVersion
	}
	if r.URL.Query().Get("latest") == "true" {
		version = ""
	}
	request, err := http.NewRequestWithContext(r.Context(), "GET", endpoint.BaseURL.ResolveReference(&url.URL{Path: "/v1/published-apps/" + app.ID + "/status", RawQuery: url.Values{"version": {version}}.Encode()}).String(), nil)
	if err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		writeError(w, 502, "application_status_failed")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		writeError(w, 502, "application_status_failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	_, _ = io.Copy(w, io.LimitReader(response.Body, 64*1024))
}
