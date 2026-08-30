package portal

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

const sessionCookie = "__Host-workagent-session"

type Server struct {
	store       *store.Store
	runtimes    runtimeapi.EmployeeRuntimeRouter
	now         func() time.Time
	secure      bool
	dummyHash   string
	sessionLife time.Duration
}

func New(data *store.Store, runtimes runtimeapi.EmployeeRuntimeRouter, secure bool) (*Server, error) {
	if data == nil || runtimes == nil {
		return nil, errors.New("store and runtime router are required")
	}
	dummyHash, err := auth.HashPassword([]byte("disabled-account-dummy-password"))
	if err != nil {
		return nil, err
	}
	return &Server{store: data, runtimes: runtimes, now: time.Now, secure: secure, dummyHash: dummyHash, sessionLife: 12 * time.Hour}, nil
}

func (s *Server) Handler() http.Handler {
	return s.HandlerWithWeb(http.NotFoundHandler())
}

func (s *Server) HandlerWithWeb(web http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.requireUser(s.logout))
	mux.HandleFunc("GET /api/auth/me", s.requireUser(s.me))
	mux.HandleFunc("/api/runtime/", s.requireUser(s.proxyRuntime))
	mux.Handle("/", web)
	return s.securityHeaders(mux)
}

type userHandler func(http.ResponseWriter, *http.Request, store.User)

func (s *Server) requireUser(next userHandler) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie(sessionCookie)
		if err != nil {
			writeError(writer, http.StatusUnauthorized, "authentication_required")
			return
		}
		user, err := s.store.UserBySession(request.Context(), cookie.Value, s.now())
		if err != nil {
			writeError(writer, http.StatusUnauthorized, "authentication_required")
			return
		}
		next(writer, request, user)
	}
}

func (s *Server) login(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 4*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || auth.ValidateUsername(input.Username) != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	user, lookupErr := s.store.UserByUsername(request.Context(), input.Username)
	encoded := s.dummyHash
	if lookupErr == nil {
		encoded = user.PasswordHash
	}
	valid := auth.VerifyPassword(encoded, []byte(input.Password))
	if lookupErr != nil || !valid || user.Disabled {
		writeError(writer, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	token, err := auth.RandomToken(32)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	expires := s.now().Add(s.sessionLife)
	if err := s.store.CreateSession(request.Context(), token, user.ID, expires); err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	http.SetCookie(writer, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, Expires: expires})
	writeJSON(writer, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) logout(writer http.ResponseWriter, request *http.Request, _ store.User) {
	cookie, _ := request.Cookie(sessionCookie)
	if err := s.store.DeleteSession(request.Context(), cookie.Value); err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	http.SetCookie(writer, &http.Cookie{Name: sessionCookie, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(writer http.ResponseWriter, _ *http.Request, user store.User) {
	writeJSON(writer, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) proxyRuntime(writer http.ResponseWriter, request *http.Request, user store.User) {
	endpoint, err := s.runtimes.Resolve(request.Context(), user.SID)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "runtime_unavailable")
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(endpoint.BaseURL)
	original := proxy.Director
	proxy.Director = func(outgoing *http.Request) {
		original(outgoing)
		outgoing.URL.Path = "/" + strings.TrimPrefix(request.URL.Path, "/api/runtime/")
		outgoing.Header.Del("Cookie")
		outgoing.Header.Set("Authorization", "Bearer "+endpoint.Token)
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, _ *http.Request, _ error) {
		writeError(response, http.StatusBadGateway, "runtime_proxy_failed")
	}
	proxy.ServeHTTP(writer, request)
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(writer, request)
	})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, map[string]string{"error": code})
}

type StaticRouter map[string]runtimeapi.Endpoint

func (r StaticRouter) Resolve(_ context.Context, sid string) (runtimeapi.Endpoint, error) {
	endpoint, ok := r[sid]
	if !ok {
		return runtimeapi.Endpoint{}, errors.New("runtime not registered")
	}
	return endpoint, nil
}
