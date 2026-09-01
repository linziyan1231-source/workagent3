package portal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/settings"
	"workagent3/internal/store"
)

const secureSessionCookie = "__Host-workagent-session"
const developmentSessionCookie = "workagent-session"

type Server struct {
	store        *store.Store
	runtimes     runtimeapi.EmployeeRuntimeRouter
	now          func() time.Time
	secure       bool
	dummyHash    string
	sessionLife  time.Duration
	modules      Modules
	sharedEvents *sharedEventHub
}

type ModelAccessPort interface {
	ListAuthorized(context.Context, string) ([]contracts.AuthorizedModel, error)
}

type QuotaUsagePort interface {
	Usage(context.Context, string, string, time.Time) (contracts.QuotaUsage, error)
}

type SpeechPort interface {
	Capability() contracts.SpeechCapability
	ServeSpeech(http.ResponseWriter, *http.Request, string)
}

type SettingsPort interface {
	Get(context.Context, string, []string) (map[string]json.RawMessage, error)
	Put(context.Context, string, map[string]json.RawMessage) error
}

type SkillMarketPort interface {
	ListApproved(context.Context, string) ([]contracts.SkillMarketEntry, error)
	ApprovedPackage(context.Context, string) (contracts.SkillMarketPackage, error)
	Delete(context.Context, string, string, bool) error
	PublishPackage(context.Context, contracts.SkillMarketPublishInput, []byte) (contracts.SkillMarketEntry, error)
}

type ChatForwardPort interface {
	ServeChatForward(http.ResponseWriter, *http.Request, contracts.ChatForwardDelegation)
}

type IMPort interface {
	ServeIM(http.ResponseWriter, *http.Request, string)
}

type NotificationsPort interface {
	Publish(context.Context, contracts.NotificationInput) (contracts.Notification, error)
	List(context.Context, string, int) ([]contracts.Notification, error)
	MarkRead(context.Context, string, string) error
	Acknowledge(context.Context, string, string) error
	Subscribe(string) (<-chan struct{}, func(), error)
}

type AuditPort interface {
	Record(context.Context, contracts.AuditInput) (contracts.AuditEvent, error)
}

type Modules struct {
	ModelAccess        ModelAccessPort
	Quota              QuotaUsagePort
	Speech             SpeechPort
	Settings           SettingsPort
	SkillMarket        SkillMarketPort
	Collaboration      CollaborationPort
	SharedProjects     SharedProjectPlatformPort
	SharedFiles        SharedFilePlatformPort
	SharedTurns        SharedTurnRunner
	ChatForward        ChatForwardPort
	IM                 IMPort
	Notifications      NotificationsPort
	Audit              AuditPort
	EmployeeManagement EmployeeManagementPort
}

func New(data *store.Store, runtimes runtimeapi.EmployeeRuntimeRouter, secure bool) (*Server, error) {
	return NewWithModules(data, runtimes, secure, Modules{})
}

func NewWithModules(data *store.Store, runtimes runtimeapi.EmployeeRuntimeRouter, secure bool, modules Modules) (*Server, error) {
	if data == nil || runtimes == nil {
		return nil, errors.New("store and runtime router are required")
	}
	if err := contracts.ValidateModuleGraph(platformModuleManifests()); err != nil {
		return nil, err
	}
	dummyHash, err := auth.HashPassword([]byte("disabled-account-dummy-password"))
	if err != nil {
		return nil, err
	}
	return &Server{store: data, runtimes: runtimes, now: time.Now, secure: secure, dummyHash: dummyHash, sessionLife: 12 * time.Hour, modules: modules, sharedEvents: newSharedEventHub()}, nil
}

func (s *Server) Handler() http.Handler {
	return s.HandlerWithWeb(http.NotFoundHandler())
}

func (s *Server) HandlerWithWeb(web http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/password", s.changePassword)
	mux.HandleFunc("POST /api/auth/logout", s.requireUser(s.logout))
	mux.HandleFunc("GET /api/auth/me", s.requireUser(s.me))
	mux.HandleFunc("GET /api/portal/me/profile", s.requireUser(s.profile))
	mux.HandleFunc("PATCH /api/portal/me/profile", s.requireUser(s.updateProfile))
	mux.HandleFunc("GET /api/portal/me/notifications", s.requireUser(s.notifications))
	mux.HandleFunc("GET /api/portal/admin/users", s.requireUser(s.requireAdmin(s.adminUsers)))
	mux.HandleFunc("POST /api/portal/admin/users", s.requireUser(s.requireAdmin(s.adminUsers)))
	mux.HandleFunc("GET /api/portal/admin/user-jobs", s.requireUser(s.requireAdmin(s.adminUserJob)))
	mux.HandleFunc("GET /api/portal/admin/users/usage", s.requireUser(s.requireAdmin(s.adminUsersUsage)))
	mux.HandleFunc("POST /api/portal/admin/users/{action}", s.requireUser(s.requireAdmin(s.adminUserAction)))
	mux.HandleFunc("POST /api/portal/admin/users/kimi-datasource", s.requireUser(s.requireAdmin(s.adminKimiDatasource)))
	mux.HandleFunc("GET /api/portal/me/notifications/stream", s.requireUser(s.notificationStream))
	mux.HandleFunc("POST /api/portal/me/notifications/{id}/read", s.requireUser(s.readNotification))
	mux.HandleFunc("POST /api/portal/me/notifications/{id}/acknowledge", s.requireUser(s.acknowledgeNotification))
	mux.HandleFunc("GET /api/system/status", s.requireUser(s.systemStatus))
	mux.HandleFunc("GET /api/system/capabilities", s.requireUser(s.systemCapabilities))
	mux.HandleFunc("GET /api/system/diagnostics", s.requireUser(s.systemDiagnostics))
	mux.HandleFunc("POST /api/system/runtime/restart", s.requireUser(s.restartRuntime))
	mux.HandleFunc("GET /api/models", s.requireUser(s.models))
	mux.HandleFunc("GET /api/quota/usage", s.requireUser(s.quotaUsage))
	mux.HandleFunc("GET /api/speech/capability", s.requireUser(s.speechCapability))
	mux.HandleFunc("GET /api/settings/client", s.requireUser(s.clientSettings))
	mux.HandleFunc("PUT /api/settings/client", s.requireUser(s.updateClientSettings))
	mux.HandleFunc("GET /api/skill-market", s.requireUser(s.skillMarket))
	mux.HandleFunc("GET /api/portal/skill-market", s.requireUser(s.skillMarket))
	mux.HandleFunc("POST /api/portal/skill-market", s.requireUser(s.publishMarketSkill))
	mux.HandleFunc("POST /api/portal/skill-market/install", s.requireUser(s.installMarketSkill))
	mux.HandleFunc("DELETE /api/portal/skill-market", s.requireUser(s.deleteMarketSkill))
	mux.HandleFunc("GET /api/portal/shared-projects", s.requireUser(s.sharedProjects))
	mux.HandleFunc("POST /api/portal/shared-projects", s.requireUser(s.sharedProjects))
	mux.HandleFunc("PATCH /api/portal/shared-projects/{id}", s.requireUser(s.sharedProject))
	mux.HandleFunc("GET /api/portal/shared-projects/{id}/members", s.requireUser(s.sharedProjectMembers))
	mux.HandleFunc("POST /api/portal/shared-projects/{id}/invites", s.requireUser(s.sharedProjectInvites))
	mux.HandleFunc("DELETE /api/portal/shared-projects/{id}/members/{userID}", s.requireUser(s.sharedProjectMember))
	mux.HandleFunc("POST /api/portal/shared-projects/{id}/ownership", s.requireUser(s.sharedProjectOwnership))
	mux.HandleFunc("/chatgpt", s.requireUser(s.chatForward))
	mux.HandleFunc("/chatgpt/", s.requireUser(s.chatForward))
	mux.HandleFunc("/api/channels/", s.requireUser(s.externalIM))
	mux.HandleFunc("GET /api/channel/weixin/login", s.requireUser(s.externalWeixinLogin))
	mux.HandleFunc("GET /api/portal/shared-invites", s.requireUser(s.sharedInvites))
	mux.HandleFunc("POST /api/portal/shared-invites", s.requireUser(s.sharedInviteByUserID))
	mux.HandleFunc("POST /api/portal/shared-invites/{id}/{action}", s.requireUser(s.sharedInviteAction))
	mux.HandleFunc("GET /api/portal/shared-users", s.requireUser(s.sharedUsers))
	mux.HandleFunc("GET /api/portal/shared-members", s.requireUser(s.sharedMembers))
	mux.HandleFunc("GET /api/portal/shared-conversations", s.requireUser(s.sharedConversations))
	mux.HandleFunc("POST /api/portal/shared-conversations", s.requireUser(s.sharedConversations))
	mux.HandleFunc("PATCH /api/portal/shared-conversations", s.requireUser(s.sharedConversations))
	mux.HandleFunc("GET /api/portal/shared-messages", s.requireUser(s.sharedMessages))
	mux.HandleFunc("POST /api/portal/shared-messages", s.requireUser(s.sharedMessages))
	mux.HandleFunc("POST /api/portal/shared-runs/cancel", s.requireUser(s.cancelSharedRun))
	mux.HandleFunc("GET /api/portal/shared-events", s.requireUser(s.sharedEventStream))
	mux.HandleFunc("POST /api/portal/shared-files", s.requireUser(s.sharedFiles))
	mux.HandleFunc("POST /api/stt", s.requireUser(s.speech))
	mux.HandleFunc("GET /api/stt/stream", s.requireUser(s.speech))
	mux.HandleFunc("/api/runtime/", s.requireUser(s.proxyRuntime))
	mux.Handle("/", web)
	return s.securityHeaders(s.correlatedAudit(s.sameOriginWrites(mux)))
}

func (s *Server) externalWeixinLogin(writer http.ResponseWriter, request *http.Request, user store.User) {
	clone := request.Clone(request.Context())
	clone.URL.Path = "/api/channels/connectors/weixin/login"
	s.externalIM(writer, clone, user)
}

func (s *Server) externalIM(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.IM == nil {
		writeError(writer, http.StatusServiceUnavailable, "im_gateway_unavailable")
		return
	}
	s.modules.IM.ServeIM(writer, request, user.SID)
}

func (s *Server) chatForward(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.ChatForward == nil {
		writeError(writer, http.StatusServiceUnavailable, "chatforward_unavailable")
		return
	}
	if request.URL.Path == "/chatgpt" {
		http.Redirect(writer, request, "/chatgpt/", http.StatusPermanentRedirect)
		return
	}
	s.modules.ChatForward.ServeChatForward(writer, request, contracts.ChatForwardDelegation{
		UserID:  strconv.FormatInt(user.ID, 10),
		NowUnix: s.now().Unix(),
	})
}

func (s *Server) skillMarket(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.SkillMarket == nil {
		writeError(writer, http.StatusServiceUnavailable, "skill_market_unavailable")
		return
	}
	entries, err := s.modules.SkillMarket.ListApproved(request.Context(), user.Username)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "skill_market_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "skills": entries})
}

func (s *Server) publishMarketSkill(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.SkillMarket == nil {
		writeError(writer, http.StatusServiceUnavailable, "skill_market_unavailable")
		return
	}
	var input struct {
		SkillName string `json:"skill_name"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || input.SkillName == "" || len(input.SkillName) > 240 {
		writeError(writer, http.StatusBadRequest, "invalid_skill_market_publish")
		return
	}
	endpoint, err := s.runtimes.Resolve(request.Context(), user.SID)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "runtime_unavailable")
		return
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/v1/skills/export", RawQuery: url.Values{"name": {input.SkillName}}.Encode()})
	downstream, _ := http.NewRequestWithContext(request.Context(), http.MethodGet, target.String(), nil)
	downstream.Header.Set("Authorization", "Bearer "+endpoint.Token)
	setCorrelationHeader(downstream)
	response, err := (&http.Client{Timeout: 2 * time.Minute}).Do(downstream)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "skill_export_failed")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "application/zip" {
		writeError(writer, http.StatusBadRequest, "skill_publish_not_allowed")
		return
	}
	archive, err := io.ReadAll(io.LimitReader(response.Body, (50<<20)+1))
	if err != nil || len(archive) == 0 || len(archive) > 50<<20 {
		clear(archive)
		writeError(writer, http.StatusBadRequest, "invalid_skill_market_package")
		return
	}
	defer clear(archive)
	encodedMetadata, err := base64.RawURLEncoding.DecodeString(response.Header.Get("X-WorkAgent-Skill-Metadata"))
	if err != nil || len(encodedMetadata) == 0 || len(encodedMetadata) > 8*1024 {
		writeError(writer, http.StatusBadGateway, "invalid_skill_export_metadata")
		return
	}
	var metadata struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Version     string `json:"version"`
	}
	metadataDecoder := json.NewDecoder(bytes.NewReader(encodedMetadata))
	metadataDecoder.DisallowUnknownFields()
	if metadataDecoder.Decode(&metadata) != nil || metadataDecoder.Decode(&struct{}{}) != io.EOF || !strings.EqualFold(metadata.Name, input.SkillName) {
		writeError(writer, http.StatusBadGateway, "invalid_skill_export_metadata")
		return
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "skill_market_failed")
		return
	}
	entry, err := s.modules.SkillMarket.PublishPackage(request.Context(), contracts.SkillMarketPublishInput{
		ID: id, Name: metadata.Name, Description: metadata.Description, Version: metadata.Version,
		PublisherUsername: user.Username, PublisherDisplayName: user.Username,
	}, archive)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "skill_market_publish_failed")
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]any{"success": true, "skill": entry})
}

func (s *Server) installMarketSkill(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.SkillMarket == nil {
		writeError(writer, http.StatusServiceUnavailable, "skill_market_unavailable")
		return
	}
	var input struct {
		ID string `json:"id"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || input.ID == "" || len(input.ID) > 128 {
		writeError(writer, http.StatusBadRequest, "invalid_skill_market_install")
		return
	}
	pack, err := s.modules.SkillMarket.ApprovedPackage(request.Context(), input.ID)
	if errors.Is(err, contracts.ErrSkillMarketEntryNotFound) {
		writeError(writer, http.StatusNotFound, "skill_market_entry_not_found")
		return
	}
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "skill_market_archive_unavailable")
		return
	}
	defer clear(pack.Archive)
	endpoint, err := s.runtimes.Resolve(request.Context(), user.SID)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "runtime_unavailable")
		return
	}
	metadata, _ := json.Marshal(map[string]string{"id": pack.ID, "name": pack.Name, "description": pack.Description, "version": pack.Version})
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/v1/skills/market-install"})
	downstream, _ := http.NewRequestWithContext(request.Context(), http.MethodPost, target.String(), bytes.NewReader(pack.Archive))
	downstream.Header.Set("Authorization", "Bearer "+endpoint.Token)
	downstream.Header.Set("Content-Type", "application/zip")
	downstream.Header.Set("X-WorkAgent-Skill-Metadata", base64.RawURLEncoding.EncodeToString(metadata))
	setCorrelationHeader(downstream)
	response, err := (&http.Client{Timeout: 2 * time.Minute}).Do(downstream)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "skill_install_failed")
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		writeError(writer, http.StatusBadGateway, "skill_install_failed")
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(response.StatusCode)
	_, _ = writer.Write(body)
}

func (s *Server) deleteMarketSkill(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.SkillMarket == nil {
		writeError(writer, http.StatusServiceUnavailable, "skill_market_unavailable")
		return
	}
	id := request.URL.Query().Get("id")
	if id == "" || len(id) > 128 {
		writeError(writer, http.StatusBadRequest, "invalid_skill_market_entry")
		return
	}
	err := s.modules.SkillMarket.Delete(request.Context(), id, user.Username, false)
	if errors.Is(err, contracts.ErrSkillMarketEntryNotFound) {
		writeError(writer, http.StatusNotFound, "skill_market_entry_not_found")
		return
	}
	if errors.Is(err, contracts.ErrSkillMarketForbidden) {
		writeError(writer, http.StatusForbidden, "skill_market_forbidden")
		return
	}
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "skill_market_failed")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) clientSettings(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Settings == nil {
		writeError(writer, http.StatusServiceUnavailable, "settings_unavailable")
		return
	}
	keys := request.URL.Query()["keys"]
	if len(keys) == 0 || len(keys) > 32 {
		writeError(writer, http.StatusBadRequest, "invalid_setting_keys")
		return
	}
	for _, key := range keys {
		if key == "" || len(key) > 128 {
			writeError(writer, http.StatusBadRequest, "invalid_setting_keys")
			return
		}
	}
	values, err := s.modules.Settings.Get(request.Context(), user.SID, keys)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "settings_failed")
		return
	}
	writeJSON(writer, http.StatusOK, values)
}

func (s *Server) updateClientSettings(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Settings == nil {
		writeError(writer, http.StatusServiceUnavailable, "settings_unavailable")
		return
	}
	values := make(map[string]json.RawMessage)
	decoder := json.NewDecoder(io.LimitReader(request.Body, 64*1024))
	if err := decoder.Decode(&values); err != nil || len(values) == 0 || len(values) > 32 {
		writeError(writer, http.StatusBadRequest, "invalid_settings")
		return
	}
	if err := s.modules.Settings.Put(request.Context(), user.SID, values); err != nil {
		if errors.Is(err, settings.ErrUnsupportedKey) {
			writeError(writer, http.StatusBadRequest, "unsupported_setting")
			return
		}
		writeError(writer, http.StatusInternalServerError, "settings_failed")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) sameOriginWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if (request.Method == http.MethodGet && !strings.EqualFold(request.Header.Get("Upgrade"), "websocket")) || request.Method == http.MethodHead || request.Method == http.MethodOptions {
			next.ServeHTTP(writer, request)
			return
		}
		scheme := "http"
		if s.secure || request.TLS != nil {
			scheme = "https"
		}
		expected := scheme + "://" + request.Host
		if !strings.EqualFold(request.Header.Get("Origin"), expected) {
			writeError(writer, http.StatusForbidden, "cross_origin_request")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

type userHandler func(http.ResponseWriter, *http.Request, store.User)

func (s *Server) requireUser(next userHandler) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie(s.cookieName())
		if err != nil {
			markAudit(request, "anonymous", true)
			writeError(writer, http.StatusUnauthorized, "authentication_required")
			return
		}
		user, err := s.store.UserBySession(request.Context(), cookie.Value, s.now())
		if err != nil {
			markAudit(request, "anonymous", true)
			writeError(writer, http.StatusUnauthorized, "authentication_required")
			return
		}
		markAudit(request, user.Username, false)
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
	markAudit(request, input.Username, false)
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
	http.SetCookie(writer, &http.Cookie{Name: s.cookieName(), Value: token, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, Expires: expires})
	writeJSON(writer, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) changePassword(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Username        string `json:"username"`
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
		ConfirmPassword string `json:"confirm_password"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		auth.ValidateUsername(input.Username) != nil || input.CurrentPassword == "" || input.NewPassword == "" || input.ConfirmPassword == "" {
		writePasswordChangeError(writer, http.StatusBadRequest, "REQUIRED_FIELDS")
		return
	}
	markAudit(request, input.Username, false)
	if input.NewPassword != input.ConfirmPassword {
		writePasswordChangeError(writer, http.StatusBadRequest, "PASSWORD_MISMATCH")
		return
	}
	if auth.ValidatePassword([]byte(input.NewPassword)) != nil {
		writePasswordChangeError(writer, http.StatusBadRequest, "PASSWORD_POLICY")
		return
	}
	user, lookupErr := s.store.UserByUsername(request.Context(), input.Username)
	encoded := s.dummyHash
	if lookupErr == nil {
		encoded = user.PasswordHash
	}
	if !auth.VerifyPassword(encoded, []byte(input.CurrentPassword)) || lookupErr != nil || user.Disabled {
		writePasswordChangeError(writer, http.StatusUnauthorized, "INVALID_CURRENT_PASSWORD")
		return
	}
	if auth.VerifyPassword(user.PasswordHash, []byte(input.NewPassword)) {
		writePasswordChangeError(writer, http.StatusBadRequest, "PASSWORD_REUSED")
		return
	}
	hash, err := auth.HashPassword([]byte(input.NewPassword))
	if err != nil {
		writePasswordChangeError(writer, http.StatusInternalServerError, "SERVER_ERROR")
		return
	}
	if err := s.store.ResetUserPassword(request.Context(), user.Username, hash); err != nil {
		writePasswordChangeError(writer, http.StatusInternalServerError, "SERVER_ERROR")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func writePasswordChangeError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, map[string]any{"success": false, "code": code})
}

func (s *Server) logout(writer http.ResponseWriter, request *http.Request, _ store.User) {
	cookie, _ := request.Cookie(s.cookieName())
	if err := s.store.DeleteSession(request.Context(), cookie.Value); err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	http.SetCookie(writer, &http.Cookie{Name: s.cookieName(), Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) cookieName() string {
	if s.secure {
		return secureSessionCookie
	}
	return developmentSessionCookie
}

func (s *Server) me(writer http.ResponseWriter, _ *http.Request, user store.User) {
	writeJSON(writer, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) models(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.ModelAccess == nil {
		writeError(writer, http.StatusServiceUnavailable, "model_access_unavailable")
		return
	}
	models, err := s.modules.ModelAccess.ListAuthorized(request.Context(), user.SID)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "model_access_failed")
		return
	}
	writeJSON(writer, http.StatusOK, models)
}

func (s *Server) quotaUsage(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Quota == nil {
		writeError(writer, http.StatusServiceUnavailable, "quota_unavailable")
		return
	}
	modelID := strings.TrimSpace(request.URL.Query().Get("model_id"))
	if modelID == "" {
		writeError(writer, http.StatusBadRequest, "model_id_required")
		return
	}
	usage, err := s.modules.Quota.Usage(request.Context(), user.SID, modelID, s.now())
	if errors.Is(err, contracts.ErrQuotaNotConfigured) {
		writeError(writer, http.StatusNotFound, "quota_not_configured")
		return
	}
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "quota_failed")
		return
	}
	writeJSON(writer, http.StatusOK, usage)
}

func (s *Server) speechCapability(writer http.ResponseWriter, _ *http.Request, _ store.User) {
	if s.modules.Speech == nil {
		writeJSON(writer, http.StatusOK, contracts.SpeechCapability{})
		return
	}
	writeJSON(writer, http.StatusOK, s.modules.Speech.Capability())
}

func (s *Server) speech(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Speech == nil {
		writeError(writer, http.StatusServiceUnavailable, "speech_disabled")
		return
	}
	s.modules.Speech.ServeSpeech(writer, request, user.SID)
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
		outgoing.Header.Set("X-Forwarded-Host", request.Host)
		if s.secure {
			outgoing.Header.Set("X-Forwarded-Proto", "https")
		} else {
			outgoing.Header.Set("X-Forwarded-Proto", "http")
		}
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, _ *http.Request, _ error) {
		writeError(response, http.StatusBadGateway, "runtime_proxy_failed")
	}
	proxy.ServeHTTP(writer, request)
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
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
