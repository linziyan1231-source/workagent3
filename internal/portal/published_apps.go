package portal

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
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
			if !ok || grant.AppID != id || grant.Preview != preview || grant.Revision != a.Revision || !a.Allows(grant.UserID, preview) {
				writeError(w, 403, "invalid_access_ticket")
				return
			}
			token, err := auth.RandomToken(24)
			if err != nil {
				writeError(w, 500, "internal_error")
				return
			}
			grant.Expires = time.Now().Add(30 * time.Minute)
			g.mu.Lock()
			if len(g.grants) >= 4096 {
				g.mu.Unlock()
				writeError(w, 503, "application_access_busy")
				return
			}
			g.grants[token] = grant
			g.mu.Unlock()
			http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 1800})
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
				if ok && time.Now().Before(grant.Expires) && grant.AppID == id && grant.Preview == preview && grant.Revision == a.Revision && a.Allows(grant.UserID, preview) {
					user, e := g.s.store.UserBySID(r.Context(), grant.SID)
					allowed = e == nil && !user.Disabled && !user.Offboarded && user.ID == grant.UserID
					if allowed {
						viewerGrant = &grant
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
						viewer, e := g.s.store.UserBySID(r.Context(), viewerGrant.SID)
						if e != nil || viewer.Disabled || viewer.Offboarded || !time.Now().Before(viewerGrant.Expires) {
							// Only this visitor's connection expires; other visitors remain connected.
							cancelProxy()
							return
						}
					}
					current, e := g.config.Store.Get(r.Context(), id)
					if e != nil || !g.s.applicationOwnerAllowed(r.Context(), a) || current.Revision != a.Revision {
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
		writeJSON(w, 200, map[string]any{"items": rows})
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
		ticket, err := auth.RandomToken(24)
		if err != nil {
			writeError(w, 500, "internal_error")
			return
		}
		s.apps.mu.Lock()
		s.apps.prune()
		if len(s.apps.tickets) >= 4096 {
			s.apps.mu.Unlock()
			writeError(w, 429, "application_access_busy")
			return
		}
		s.apps.tickets[ticket] = appGrant{id, user.SID, user.ID, a.Revision, preview, time.Now().Add(time.Minute)}
		s.apps.mu.Unlock()
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
	if action == "versions" || action == "previews" || action == "publish" {
		if !s.applicationOwnerAllowed(r.Context(), a) {
			writeError(w, 403, "application_owner_required")
			return
		}
	}
	if action == "versions" || action == "previews" || action == "publish" {
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
func (s *Server) stopApplication(w http.ResponseWriter, r *http.Request, user store.User, a publishedapps.App, expected int64, action string) {
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
	a.Enabled = false
	a.PreviewVersion = ""
	updated, err := s.modules.PublishedApps.Store.Update(r.Context(), a, expected)
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
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
	err = s.appRuntimeOperation(ctx, updated, "stop", nil)
	s.recordBusinessEvent(ctx, user.Username, "application."+action, a.ID, err, nil)
	if err != nil {
		writeError(w, 502, "application_stop_failed")
		return
	}
	writeJSON(w, 200, updated)
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
	_ = applicationEntryTemplate.Execute(w, map[string]string{"ID": a.ID, "Preview": strconv.FormatBool(preview)})
}

var applicationEntryTemplate = template.Must(template.New("application-entry").Parse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>打开应用</title><p>登录 WorkAgent 后，点击打开应用。</p><a href="/" target="_blank" rel="noopener">登录 WorkAgent</a><form method="post" action="/api/portal/apps/{{.ID}}/open?preview={{.Preview}}"><button>打开应用</button></form>`))

func (s *Server) applicationOpen(w http.ResponseWriter, r *http.Request, user store.User) {
	// Render a user-initiated POST exchange without inline scripts or URL tokens.
	recorder := &appTicketResponse{header: http.Header{}}
	r.SetPathValue("action", "access-ticket")
	s.publishedAppsHTTP(recorder, r, user)
	if recorder.status != 200 {
		for key, values := range recorder.header {
			w.Header()[key] = values
		}
		w.WriteHeader(recorder.status)
		_, _ = w.Write(recorder.body.Bytes())
		return
	}
	var ticket map[string]string
	_ = json.Unmarshal(recorder.body.Bytes(), &ticket)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// The exchange crosses ports. A same-origin policy would make its native
	// form POST Origin opaque again, so retain the origin-only policy here.
	w.Header().Set("Referrer-Policy", "origin")
	_ = appExchangeTemplate.Execute(w, ticket)
}

type appTicketResponse struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (r *appTicketResponse) Header() http.Header             { return r.header }
func (r *appTicketResponse) WriteHeader(status int)          { r.status = status }
func (r *appTicketResponse) Write(value []byte) (int, error) { return r.body.Write(value) }

var appExchangeTemplate = template.Must(template.New("app-exchange").Parse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>访问应用</title><form method="post" action="{{.url}}"><input type="hidden" name="ticket" value="{{.ticket}}"><button>进入应用</button></form>`))
