package portal

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"workagent3/internal/auth"
	"workagent3/internal/publishedapps"
	"workagent3/internal/store"
)

type PublishedAppsConfig struct {
	Store        *publishedapps.Store
	PublicURL    string
	BindHost     string
	EmployeeRoot string
}
type appGrant struct {
	AppID, SID       string
	UserID, Revision int64
	Preview          bool
	Expires          time.Time
	// Anonymous marks grants issued through share tokens or access codes;
	// they carry no WorkAgent identity and skip user revalidation.
	Anonymous bool
}
type applicationGateway struct {
	s               *Server
	config          PublishedAppsConfig
	mu              sync.Mutex
	listeners       map[string]*http.Server
	tickets, grants map[string]appGrant
	connections     map[string]map[net.Conn]bool
	inflight        map[string]int
	provisioning    map[string]time.Time
	requests        map[string]map[uint64]*appGatewayRequest
	stopping        map[string]bool
	passwordFails   map[string][]time.Time
	nextRequest     uint64
}
type appGatewayRequest struct {
	cancel context.CancelFunc
	done   chan struct{}
}
type appConnectionKey struct{}

func (g *applicationGateway) beginRequest(id string, parent context.Context) (context.Context, context.CancelFunc, func()) {
	ctx, cancel := context.WithCancel(parent)
	stop := func() {
		cancel()
		if conn, ok := parent.Value(appConnectionKey{}).(net.Conn); ok {
			_ = conn.Close()
		}
	}
	entry := &appGatewayRequest{cancel: stop, done: make(chan struct{})}
	g.mu.Lock()
	if g.requests == nil {
		g.requests = map[string]map[uint64]*appGatewayRequest{}
	}
	if g.requests[id] == nil {
		g.requests[id] = map[uint64]*appGatewayRequest{}
	}
	g.nextRequest++
	key := g.nextRequest
	g.requests[id][key] = entry
	g.mu.Unlock()
	return ctx, stop, func() { cancel(); g.mu.Lock(); delete(g.requests[id], key); close(entry.done); g.mu.Unlock() }
}

type applicationWriter struct {
	http.ResponseWriter
	connection net.Conn
	onHijack   func(net.Conn)
}

func (s *Server) applicationOwnerAllowed(ctx context.Context, a publishedapps.App) bool {
	owner, err := s.store.UserBySID(ctx, a.OwnerSID)
	if err != nil || owner.Disabled || owner.Offboarded {
		return false
	}
	if strings.HasPrefix(a.WorkspaceID, "shared:") {
		if s.modules.Collaboration == nil {
			return false
		}
		project, err := s.modules.Collaboration.ProjectForUser(ctx, strings.TrimPrefix(a.WorkspaceID, "shared:"), owner.ID, true)
		return err == nil && project.OwnerSID == a.OwnerSID && (project.State == "active" || project.State == "transfer_pending")
	}
	return true
}

func (w *applicationWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *applicationWriter) Flush()                      { _ = http.NewResponseController(w.ResponseWriter).Flush() }
func (w *applicationWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.connection = conn
		w.onHijack(conn)
	}
	return conn, rw, err
}
func (g *applicationGateway) disconnect(id string) []<-chan struct{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	for conn := range g.connections[id] {
		_ = conn.Close()
	}
	delete(g.connections, id)
	var pending []<-chan struct{}
	for _, request := range g.requests[id] {
		request.cancel()
		pending = append(pending, request.done)
	}
	delete(g.requests, id)
	return pending
}
func (s *Server) StartPublishedApps() error {
	if s.modules.PublishedApps.Store == nil {
		return nil
	}
	apps, err := s.modules.PublishedApps.Store.List(context.Background(), "")
	if err != nil {
		return err
	}
	for _, a := range apps {
		if err = s.apps.listen(a); err != nil {
			log.Printf("published app %s listener unavailable: %v", a.ID, err)
		}
	}
	return nil
}
func (s *Server) ClosePublishedApps() {
	if s.apps == nil {
		return
	}
	s.apps.mu.Lock()
	defer s.apps.mu.Unlock()
	for _, server := range s.apps.listeners {
		_ = server.Close()
	}
	for _, connections := range s.apps.connections {
		for conn := range connections {
			_ = conn.Close()
		}
	}
	for _, requests := range s.apps.requests {
		for _, request := range requests {
			request.cancel()
		}
	}
}
func (g *applicationGateway) address(a publishedapps.App, preview bool) string {
	u, _ := url.Parse(g.config.PublicURL)
	port := a.Port
	if preview {
		port = a.PreviewPort
	}
	return "http://" + net.JoinHostPort(u.Hostname(), strconv.Itoa(port))
}
func (g *applicationGateway) listen(a publishedapps.App) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, preview := range []bool{false, true} {
		key := a.ID + strconv.FormatBool(preview)
		if g.listeners[key] != nil {
			continue
		}
		port := a.Port
		if preview {
			port = a.PreviewPort
		}
		listener, err := net.Listen("tcp", net.JoinHostPort(g.config.BindHost, strconv.Itoa(port)))
		if err != nil {
			return err
		}
		server := &http.Server{Handler: g.handler(a.ID, preview), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024, ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
			return context.WithValue(ctx, appConnectionKey{}, conn)
		}}
		g.listeners[key] = server
		go server.Serve(listener)
	}
	return nil
}
func (g *applicationGateway) prune() {
	now := time.Now()
	for key, v := range g.tickets {
		if now.After(v.Expires) {
			delete(g.tickets, key)
		}
	}
	for key, v := range g.grants {
		if now.After(v.Expires) {
			delete(g.grants, key)
		}
	}
}

// anonymousMode reports whether the app admits visitors without a WorkAgent
// account (share token or access code modes).
func anonymousMode(a publishedapps.App) bool {
	return a.Access == publishedapps.AccessToken || a.Access == publishedapps.AccessPassword
}

func grantAllowed(a publishedapps.App, grant appGrant) bool {
	if a.Allows(grant.UserID, grant.Preview) {
		return true
	}
	return grant.Anonymous && anonymousMode(a) && a.Enabled && !a.Expired(time.Now())
}

func anonymousGrantExpiry(a publishedapps.App) time.Time {
	until := time.Now().Add(12 * time.Hour)
	if !a.ExpiresAt.IsZero() && a.ExpiresAt.Before(until) {
		until = a.ExpiresAt
	}
	return until
}

// newTicket mints a single-use access ticket exchanged at the app listener.
func (g *applicationGateway) newTicket(a publishedapps.App, sid string, userID int64, preview, anonymous bool) (string, error) {
	ticket, err := auth.RandomToken(24)
	if err != nil {
		return "", err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.prune()
	if len(g.tickets) >= 4096 {
		return "", errors.New("application_access_busy")
	}
	g.tickets[ticket] = appGrant{AppID: a.ID, SID: sid, UserID: userID, Revision: a.Revision, Preview: preview, Expires: time.Now().Add(time.Minute), Anonymous: anonymous}
	return ticket, nil
}

// shareTokenAccess admits visitors arriving on the /t/{token}/ share link by
// issuing an anonymous grant and cookie, then redirecting to the app root.
func (g *applicationGateway) shareTokenAccess(w http.ResponseWriter, r *http.Request, a publishedapps.App, preview bool, cookieName string) {
	token := strings.Trim(strings.TrimPrefix(r.URL.Path, "/t/"), "/")
	if preview || a.Access != publishedapps.AccessToken || a.ShareToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(a.ShareToken)) != 1 || !a.Enabled || a.Expired(time.Now()) {
		writeError(w, 403, "application_access_required")
		return
	}
	grantToken, err := auth.RandomToken(24)
	if err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	expires := anonymousGrantExpiry(a)
	g.mu.Lock()
	if len(g.grants) >= 4096 {
		g.mu.Unlock()
		writeError(w, 503, "application_access_busy")
		return
	}
	g.grants[grantToken] = appGrant{AppID: a.ID, Revision: a.Revision, Expires: expires, Anonymous: true}
	g.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: grantToken, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: int(time.Until(expires).Seconds())})
	http.Redirect(w, r, "/", 303)
}

func (g *applicationGateway) unlisten(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, preview := range []bool{false, true} {
		key := id + strconv.FormatBool(preview)
		if server := g.listeners[key]; server != nil {
			_ = server.Close()
			delete(g.listeners, key)
		}
	}
}
func (g *applicationGateway) handler(id string, preview bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		if g.inflight == nil {
			g.inflight = map[string]int{}
		}
		if g.inflight[id] >= 16 {
			g.mu.Unlock()
			writeError(w, 429, "application_busy")
			return
		}
		g.inflight[id]++
		g.mu.Unlock()
		defer func() { g.mu.Lock(); g.inflight[id]--; g.mu.Unlock() }()
		requestContext, cancelProxy, finishRequest := g.beginRequest(id, r.Context())
		defer finishRequest()
		r = r.WithContext(requestContext)
		a, err := g.config.Store.Get(r.Context(), id)
		if err != nil {
			writeError(w, 404, "application_not_found")
			return
		}
		if !g.s.applicationOwnerAllowed(r.Context(), a) {
			writeError(w, 403, "application_unavailable")
			return
		}
		origin := g.address(a, preview)
		if r.Host != strings.TrimPrefix(origin, "http://") {
			writeError(w, 400, "invalid_application_host")
			return
		}
		cookieName := "wa-app-" + id + "-" + strconv.FormatBool(preview)
		if strings.HasPrefix(r.URL.Path, "/t/") {
			g.shareTokenAccess(w, r, a, preview, cookieName)
			return
		}
		if r.URL.Path == "/__workagent/access" {
			if r.Method != "POST" || r.Header.Get("Origin") != g.config.PublicURL {
				writeError(w, 403, "invalid_access_exchange")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 4096)
			if r.ParseForm() != nil {
				writeError(w, 400, "invalid_access_ticket")
				return
			}
			g.mu.Lock()
			g.prune()
			grant, ok := g.tickets[r.FormValue("ticket")]
			delete(g.tickets, r.FormValue("ticket"))
			g.mu.Unlock()
			if !ok || grant.AppID != id || grant.Preview != preview || grant.Revision != a.Revision || !grantAllowed(a, grant) {
				writeError(w, 403, "invalid_access_ticket")
				return
			}
			token, err := auth.RandomToken(24)
			if err != nil {
				writeError(w, 500, "internal_error")
				return
			}
			grant.Expires = time.Now().Add(30 * time.Minute)
			if grant.Anonymous {
				grant.Expires = anonymousGrantExpiry(a)
			}
			g.mu.Lock()
			if len(g.grants) >= 4096 {
				g.mu.Unlock()
				writeError(w, 503, "application_access_busy")
				return
			}
			g.grants[token] = grant
			g.mu.Unlock()
			http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: int(time.Until(grant.Expires).Seconds())})
			http.Redirect(w, r, "/", 303)
			return
		}
		allowed := a.Allows(0, preview)
		var viewerGrant *appGrant
		if !allowed {
			cookie, e := uniqueCookie(r, cookieName)
			if e == nil {
				g.mu.Lock()
				grant, ok := g.grants[cookie.Value]
				g.mu.Unlock()
				if ok && time.Now().Before(grant.Expires) && grant.AppID == id && grant.Preview == preview && grant.Revision == a.Revision && grantAllowed(a, grant) {
					if grant.Anonymous {
						allowed = true
						viewerGrant = &grant
					} else {
						user, e := g.s.store.UserBySID(r.Context(), grant.SID)
						allowed = e == nil && !user.Disabled && !user.Offboarded && user.ID == grant.UserID
						if allowed {
							viewerGrant = &grant
						}
					}
				}
			}
		}
		if !allowed {
			if r.Method == "GET" && r.URL.Path == "/" {
				http.Redirect(w, r, g.config.PublicURL+"/apps/"+id+"?preview="+strconv.FormatBool(preview), 303)
			} else {
				writeError(w, 403, "application_access_required")
			}
			return
		}
		if (isWrite(r.Method) || strings.EqualFold(r.Header.Get("Upgrade"), "websocket")) && r.Header.Get("Origin") != origin {
			writeError(w, 403, "cross_origin_request")
			return
		}
		version := a.Version
		if preview {
			version = a.PreviewVersion
		}
		if version == "" {
			writeError(w, 409, "application_not_published")
			return
		}
		if tracker, ok := g.s.runtimes.(interface{ BeginRequest(string) (func(), error) }); ok {
			done, e := tracker.BeginRequest(a.OwnerSID)
			if e != nil {
				writeError(w, 503, "application_unavailable")
				return
			}
			defer done()
		}
		endpoint, err := g.s.runtimes.Resolve(r.Context(), a.OwnerSID)
		if err != nil {
			writeError(w, 503, "application_starting_failed")
			return
		}
		proxy := httputil.NewSingleHostReverseProxy(endpoint.BaseURL)
		base := proxy.Director
		proxy.Director = func(out *http.Request) {
			businessAuthorization := out.Header.Get("Authorization")
			applicationOrigin := out.Header.Get("Origin")
			base(out)
			out.URL.Path = "/v1/published-apps/" + id + "/content" + r.URL.Path
			out.URL.RawPath = ""
			for key := range out.Header {
				if strings.HasPrefix(strings.ToLower(key), "x-workagent-") {
					out.Header.Del(key)
				}
			}
			out.Header.Del("Cookie")
			out.Header.Set("Authorization", "Bearer "+endpoint.Token)
			out.Header.Set("X-WorkAgent-App-Authorization", businessAuthorization)
			out.Header.Set("X-WorkAgent-App-Origin", applicationOrigin)
			out.Header.Set("X-WorkAgent-App-Version", version)
			out.Header.Set("X-WorkAgent-App-Preview", strconv.FormatBool(preview))
			out.Header.Set("Origin", endpoint.BaseURL.Scheme+"://"+endpoint.BaseURL.Host)
		}
		proxy.ModifyResponse = func(response *http.Response) error {
			for _, key := range []string{"Set-Cookie", "Set-Cookie2", "Clear-Site-Data", "Service-Worker-Allowed", "Content-Security-Policy", "Content-Security-Policy-Report-Only", "Report-To", "Reporting-Endpoints", "NEL", "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials"} {
				response.Header.Del(key)
			}
			response.Header.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors "+g.config.PublicURL)
			response.Header.Set("X-Content-Type-Options", "nosniff")
			response.Header.Set("Referrer-Policy", "no-referrer")
			response.Header.Set("Cache-Control", "private, no-store")
			return nil
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) { writeError(w, 502, "application_unavailable") }
		r.Body = http.MaxBytesReader(w, r.Body, 16*1024*1024)
		tracked := &applicationWriter{ResponseWriter: w, onHijack: func(conn net.Conn) {
			g.mu.Lock()
			if g.connections == nil {
				g.connections = map[string]map[net.Conn]bool{}
			}
			if g.connections[id] == nil {
				g.connections[id] = map[net.Conn]bool{}
			}
			g.connections[id][conn] = true
			g.mu.Unlock()
		}}
		done := make(chan struct{})
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-ticker.C:
					if viewerGrant != nil {
						if viewerGrant.SID != "" {
							viewer, e := g.s.store.UserBySID(r.Context(), viewerGrant.SID)
							if e != nil || viewer.Disabled || viewer.Offboarded {
								// Only this visitor's connection expires; other visitors remain connected.
								cancelProxy()
								return
							}
						}
						if !time.Now().Before(viewerGrant.Expires) {
							cancelProxy()
							return
						}
					}
					current, e := g.config.Store.Get(r.Context(), id)
					if e != nil || !g.s.applicationOwnerAllowed(r.Context(), a) || current.Revision != a.Revision || current.Expired(time.Now()) {
						g.disconnect(id)
						return
					}
				}
			}
		}()
		proxy.ServeHTTP(tracked, r)
		close(done)
		if tracked.connection != nil {
			g.mu.Lock()
			delete(g.connections[id], tracked.connection)
			g.mu.Unlock()
		}
	})
}

func (s *Server) publishedAppsHTTP(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.apps == nil {
		writeError(w, 503, "application_publishing_unavailable")
		return
	}
	apps := s.modules.PublishedApps.Store
	id := r.PathValue("id")
	action := r.PathValue("action")
	if id == "" && r.Method == "GET" {
		rows, err := apps.List(r.Context(), user.SID)
		if err != nil {
			writeError(w, 500, "applications_failed")
			return
		}
		items := make([]appSummary, 0, len(rows))
		for _, a := range rows {
			items = append(items, s.appSummary(a))
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	if id == "" && r.Method == "POST" {
		var a publishedapps.App
		if json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&a) != nil {
			writeError(w, 400, "invalid_application")
			return
		}
		a.OwnerID = user.ID
		a.OwnerSID = user.SID
		if strings.HasPrefix(a.WorkspaceID, "shared:") {
			if s.modules.Collaboration == nil {
				writeError(w, 403, "project_owner_required")
				return
			}
			project, err := s.modules.Collaboration.ProjectForUser(r.Context(), strings.TrimPrefix(a.WorkspaceID, "shared:"), user.ID, true)
			if err != nil || project.OwnerSID != user.SID {
				writeError(w, 403, "project_owner_required")
				return
			}
		}
		created, err := apps.Create(r.Context(), a)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		// Identity and ports remain reserved if binding is temporarily unavailable.
		// Subsequent preview/publish operations retry binding that same identity.
		if err = s.apps.listen(created); err != nil {
			log.Printf("published app %s listener unavailable: %v", created.ID, err)
		}
		writeJSON(w, 201, created)
		return
	}
	a, err := apps.Get(r.Context(), id)
	if err != nil {
		writeError(w, 404, "application_not_found")
		return
	}
	if action == "access-ticket" {
		if !s.applicationOwnerAllowed(r.Context(), a) {
			writeError(w, 403, "application_unavailable")
			return
		}
		if err = s.apps.listen(a); err != nil {
			writeError(w, 503, "application_port_unavailable")
			return
		}
		preview := r.URL.Query().Get("preview") == "true"
		if !a.Allows(user.ID, preview) {
			writeError(w, 403, "application_access_required")
			return
		}
		ticket, err := s.apps.newTicket(a, user.SID, user.ID, preview, false)
		if err != nil {
			writeError(w, 429, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"ticket": ticket, "url": s.apps.address(a, preview) + "/__workagent/access"})
		return
	}
	if a.OwnerSID != user.SID {
		writeError(w, 403, "application_owner_required")
		return
	}
	if r.Method == "GET" {
		writeJSON(w, 200, a)
		return
	}
	expected := a.Revision
	s.apps.mu.Lock()
	stopping := s.apps.stopping[id]
	s.apps.mu.Unlock()
	if stopping {
		writeError(w, 409, "application_stopping")
		return
	}
	if action == "versions" || action == "previews" || action == "publish" || action == "enable" || action == "delete" {
		if !s.applicationOwnerAllowed(r.Context(), a) {
			writeError(w, 403, "application_owner_required")
			return
		}
	}
	if action == "versions" || action == "previews" || action == "publish" || action == "enable" {
		if err = s.apps.listen(a); err != nil {
			writeError(w, 503, "application_port_unavailable")
			return
		}
	}
	if action == "versions" || action == "previews" {
		version, err := auth.RandomToken(18)
		if err != nil {
			writeError(w, 500, "internal_error")
			return
		}
		input := map[string]any{"workspaceId": a.WorkspaceID, "kind": a.Kind, "entry": a.Entry, "allowedOrigins": a.AllowedOrigins, "version": version, "preview": action == "previews"}
		if err = s.appRuntimeOperation(r.Context(), a, "versions", input); err != nil {
			writeError(w, 502, err.Error())
			return
		}
		if action == "previews" {
			a.PreviewVersion = version
		} else {
			a.Versions = append(a.Versions, version)
		}
	} else if action == "publish" {
		var input struct {
			Version         string   `json:"version"`
			Access          string   `json:"access"`
			Members         []int64  `json:"members"`
			MemberUsernames []string `json:"memberUsernames"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&input) != nil {
			writeError(w, 400, "invalid_application")
			return
		}
		found := false
		for _, v := range a.Versions {
			if v == input.Version {
				found = true
			}
		}
		if !found {
			writeError(w, 400, "unknown_application_version")
			return
		}
		for _, name := range input.MemberUsernames {
			member, e := s.store.UserByUsername(r.Context(), strings.TrimSpace(name))
			if e != nil || member.Disabled || member.Offboarded {
				writeError(w, 400, "application_member_not_found")
				return
			}
			input.Members = append(input.Members, member.ID)
		}
		a.Version = input.Version
		a.Access = input.Access
		a.Members = input.Members
		a.Enabled = true
	} else if action == "enable" {
		if a.Version == "" {
			writeError(w, 409, "application_not_published")
			return
		}
		a.Enabled = true
		if a.Expired(time.Now()) {
			a.ExpiresAt = time.Now().Add(publishedapps.DefaultValidity)
		}
	} else if action == "delete" {
		s.deleteApplication(w, r, user, a)
		return
	} else if action == "stop" || action == "unpublish" {
		s.stopApplication(w, r, user, a, expected, action)
		return
	} else {
		writeError(w, 405, "method_not_allowed")
		return
	}
	updated, err := apps.Update(r.Context(), a, expected)
	if err == nil {
		s.apps.disconnect(id)
	}
	s.recordBusinessEvent(r.Context(), user.Username, "application."+action, id, err, nil)
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, updated)
}

// appSummary decorates an app with the share links shown to its owner. The
// password is exposed as accessCode only to the owner through this summary.
type appSummary struct {
	publishedapps.App
	URL        string `json:"url"`
	ShareURL   string `json:"shareUrl"`
	AccessCode string `json:"accessCode,omitempty"`
}

func (s *Server) appSummary(a publishedapps.App) appSummary {
	summary := appSummary{App: a, URL: strings.TrimRight(s.apps.config.PublicURL, "/") + "/apps/" + a.ID}
	summary.ShareURL = summary.URL
	switch a.Access {
	case publishedapps.AccessToken:
		if a.ShareToken != "" {
			summary.ShareURL = s.apps.address(a, false) + "/t/" + a.ShareToken + "/"
		}
	case publishedapps.AccessPassword:
		summary.ShareURL = s.apps.address(a, false) + "/"
		summary.AccessCode = a.Password
	}
	return summary
}

func (s *Server) stopApplication(w http.ResponseWriter, r *http.Request, user store.User, a publishedapps.App, expected int64, action string) {
	updated, status, message, stopErr := s.stopApp(r.Context(), a, expected)
	if status == http.StatusOK || stopErr != nil {
		s.recordBusinessEvent(r.Context(), user.Username, "application."+action, a.ID, stopErr, nil)
	}
	if status != http.StatusOK {
		writeError(w, status, message)
		return
	}
	writeJSON(w, 200, updated)
}

// stopApp disables the app, drops its live connections and tells the employee
// runtime to stop serving it. It is shared by the owner stop/unpublish route
// and the admin unpublish route. The returned status and message describe a
// failure to the HTTP caller; stopErr carries the runtime-stop error for the
// audit record and is only set when the runtime stop itself failed.
func (s *Server) stopApp(ctx context.Context, a publishedapps.App, expected int64) (publishedapps.App, int, string, error) {
	s.apps.mu.Lock()
	if s.apps.stopping == nil {
		s.apps.stopping = map[string]bool{}
	}
	if s.apps.stopping[a.ID] {
		s.apps.mu.Unlock()
		return a, http.StatusConflict, "application_stopping", nil
	}
	s.apps.stopping[a.ID] = true
	s.apps.mu.Unlock()
	defer func() { s.apps.mu.Lock(); delete(s.apps.stopping, a.ID); s.apps.mu.Unlock() }()
	a.Enabled = false
	a.PreviewVersion = ""
	updated, err := s.modules.PublishedApps.Store.Update(ctx, a, expected)
	if err != nil {
		return a, http.StatusConflict, err.Error(), nil
	}
	pending := s.apps.disconnect(a.ID)
	waitCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	for _, done := range pending {
		select {
		case <-done:
		case <-waitCtx.Done():
			return updated, http.StatusServiceUnavailable, "application_stop_pending", nil
		}
	}
	if err = s.appRuntimeOperation(waitCtx, updated, "stop", nil); err != nil {
		return updated, http.StatusBadGateway, "application_stop_failed", err
	}
	return updated, http.StatusOK, "", nil
}

// deleteApplication stops serving the app and soft-deletes its record. The
// runtime stop is best-effort: deletion must succeed while the employee
// runtime is offline.
func (s *Server) deleteApplication(w http.ResponseWriter, r *http.Request, user store.User, a publishedapps.App) {
	s.apps.mu.Lock()
	if s.apps.stopping == nil {
		s.apps.stopping = map[string]bool{}
	}
	if s.apps.stopping[a.ID] {
		s.apps.mu.Unlock()
		writeError(w, 409, "application_stopping")
		return
	}
	s.apps.stopping[a.ID] = true
	s.apps.mu.Unlock()
	defer func() { s.apps.mu.Lock(); delete(s.apps.stopping, a.ID); s.apps.mu.Unlock() }()
	pending := s.apps.disconnect(a.ID)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 20*time.Second)
	defer cancel()
	for _, done := range pending {
		select {
		case <-done:
		case <-ctx.Done():
			writeError(w, 503, "application_stop_pending")
			return
		}
	}
	if err := s.appRuntimeOperation(ctx, a, "stop", nil); err != nil {
		log.Printf("published app %s runtime stop during delete: %v", a.ID, err)
	}
	err := s.modules.PublishedApps.Store.Delete(r.Context(), a.ID, a.OwnerSID)
	s.recordBusinessEvent(ctx, user.Username, "application.delete", a.ID, err, nil)
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	s.apps.unlisten(a.ID)
	writeJSON(w, 200, map[string]bool{"deleted": true})
}
func (s *Server) appRuntimeOperation(ctx context.Context, a publishedapps.App, action string, input any) error {
	if tracker, ok := s.runtimes.(interface{ BeginRequest(string) (func(), error) }); ok {
		done, err := tracker.BeginRequest(a.OwnerSID)
		if err != nil {
			return err
		}
		defer done()
	}
	if action == "versions" {
		if values, ok := input.(map[string]any); ok {
			if version, ok := values["version"].(string); ok {
				s.apps.mu.Lock()
				if s.apps.provisioning == nil {
					s.apps.provisioning = map[string]time.Time{}
				}
				s.apps.provisioning[a.ID+"/"+version] = time.Now().Add(2 * time.Minute)
				s.apps.mu.Unlock()
				defer func() { s.apps.mu.Lock(); delete(s.apps.provisioning, a.ID+"/"+version); s.apps.mu.Unlock() }()
			}
		}
	}
	endpoint, err := s.runtimes.Resolve(ctx, a.OwnerSID)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(input)
	request, err := http.NewRequestWithContext(ctx, "POST", endpoint.BaseURL.ResolveReference(&url.URL{Path: "/v1/published-apps/" + a.ID + "/" + action}).String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", endpoint.BaseURL.Scheme+"://"+endpoint.BaseURL.Host)
	response, err := (&http.Client{Timeout: 2 * time.Minute}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("application_runtime_failed_%d", response.StatusCode)
	}
	return nil
}
func (s *Server) applicationEntry(w http.ResponseWriter, r *http.Request) {
	if s.apps == nil {
		writeError(w, 503, "application_publishing_unavailable")
		return
	}
	a, err := s.modules.PublishedApps.Store.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "application_not_found")
		return
	}
	preview := r.URL.Query().Get("preview") == "true"
	if err = s.apps.listen(a); err != nil {
		writeError(w, 503, "application_port_unavailable")
		return
	}
	if a.Allows(0, preview) {
		http.Redirect(w, r, s.apps.address(a, preview), 302)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// Native form POSTs need a non-opaque Origin for the existing CSRF check.
	// Send only the Portal origin, never this page's path or any ticket data.
	w.Header().Set("Referrer-Policy", "origin")
	if !preview && a.Expired(time.Now()) {
		_ = applicationMessageTemplate.Execute(w, map[string]string{"Message": "此网页已过有效期，请联系发布者重新发布。"})
		return
	}
	if !preview && a.Access == publishedapps.AccessToken {
		if token := r.URL.Query().Get("token"); token != "" && a.ShareToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(a.ShareToken)) == 1 {
			s.renderAppExchange(w, a, "", 0, false, true)
			return
		}
		_ = applicationMessageTemplate.Execute(w, map[string]string{"Message": "此网页通过专属链接访问，请使用发布时生成的完整链接。"})
		return
	}
	if !preview && a.Access == publishedapps.AccessPassword {
		_ = applicationPasswordTemplate.Execute(w, map[string]string{"ID": a.ID, "Preview": "false", "Error": ""})
		return
	}
	_ = applicationEntryTemplate.Execute(w, map[string]string{"ID": a.ID, "Preview": strconv.FormatBool(preview)})
}

var applicationEntryTemplate = template.Must(template.New("application-entry").Parse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>打开应用</title><p>登录 WorkAgent 后，点击打开应用。</p><a href="/" target="_blank" rel="noopener">登录 WorkAgent</a><form method="post" action="/api/portal/apps/{{.ID}}/open?preview={{.Preview}}"><button>打开应用</button></form>`))

var applicationMessageTemplate = template.Must(template.New("application-message").Parse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>访问网页</title><p>{{.Message}}</p>`))

var applicationPasswordTemplate = template.Must(template.New("application-password").Parse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>访问网页</title><p>此网页需要 8 位访问密码。</p>{{if .Error}}<p>{{.Error}}</p>{{end}}<form method="post" action="/api/portal/apps/{{.ID}}/password?preview={{.Preview}}"><input name="password" type="password" inputmode="numeric" autocomplete="off" maxlength="8" required><button>打开网页</button></form>`))

// renderAppExchange mints a single-use ticket and renders the user-initiated
// POST exchange form that carries no ticket in the URL.
func (s *Server) renderAppExchange(w http.ResponseWriter, a publishedapps.App, sid string, userID int64, preview, anonymous bool) {
	ticket, err := s.apps.newTicket(a, sid, userID, preview, anonymous)
	if err != nil {
		writeError(w, 429, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// The exchange crosses ports. A same-origin policy would make its native
	// form POST Origin opaque again, so retain the origin-only policy here.
	w.Header().Set("Referrer-Policy", "origin")
	_ = appExchangeTemplate.Execute(w, map[string]string{"url": s.apps.address(a, preview) + "/__workagent/access", "ticket": ticket})
}

func (s *Server) applicationOpen(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.apps == nil {
		writeError(w, 503, "application_publishing_unavailable")
		return
	}
	a, err := s.modules.PublishedApps.Store.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "application_not_found")
		return
	}
	preview := r.URL.Query().Get("preview") == "true"
	if !s.applicationOwnerAllowed(r.Context(), a) {
		writeError(w, 403, "application_unavailable")
		return
	}
	if err = s.apps.listen(a); err != nil {
		writeError(w, 503, "application_port_unavailable")
		return
	}
	if !a.Allows(user.ID, preview) {
		writeError(w, 403, "application_access_required")
		return
	}
	s.renderAppExchange(w, a, user.SID, user.ID, preview, false)
}

// applicationPassword verifies an 8-digit access code without requiring a
// WorkAgent account and renders the ticket exchange form on success.
func (s *Server) applicationPassword(w http.ResponseWriter, r *http.Request) {
	if s.apps == nil {
		writeError(w, 503, "application_publishing_unavailable")
		return
	}
	a, err := s.modules.PublishedApps.Store.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, 404, "application_not_found")
		return
	}
	if a.Access != publishedapps.AccessPassword || !a.Enabled || a.Expired(time.Now()) || r.URL.Query().Get("preview") == "true" {
		writeError(w, 403, "application_access_required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if r.ParseForm() != nil {
		writeError(w, 400, "invalid_application_password")
		return
	}
	host, _, splitErr := net.SplitHostPort(r.RemoteAddr)
	if splitErr != nil {
		host = r.RemoteAddr
	}
	if !s.apps.allowPasswordAttempt(a.ID + "|" + host) {
		writeError(w, 429, "application_password_busy")
		return
	}
	if a.Password == "" || subtle.ConstantTimeCompare([]byte(r.FormValue("password")), []byte(a.Password)) != 1 {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "origin")
		w.WriteHeader(403)
		_ = applicationPasswordTemplate.Execute(w, map[string]string{"ID": a.ID, "Preview": "false", "Error": "访问密码不正确。"})
		return
	}
	s.renderAppExchange(w, a, "", 0, false, true)
}

// allowPasswordAttempt limits access-code guesses to 10 per app and client
// per 10 minutes.
func (g *applicationGateway) allowPasswordAttempt(key string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.passwordFails == nil {
		g.passwordFails = map[string][]time.Time{}
	}
	cutoff := time.Now().Add(-10 * time.Minute)
	kept := g.passwordFails[key][:0]
	for _, at := range g.passwordFails[key] {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= 10 {
		g.passwordFails[key] = kept
		return false
	}
	g.passwordFails[key] = append(kept, time.Now())
	return true
}

var appExchangeTemplate = template.Must(template.New("app-exchange").Parse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>访问应用</title><form method="post" action="{{.url}}"><input type="hidden" name="ticket" value="{{.ticket}}"><button>进入应用</button></form>`))
