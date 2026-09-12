package portal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"workagent3/internal/acpcatalog"
	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/feedback"
	"workagent3/internal/marketplace"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/settings"
	"workagent3/internal/store"
)

const secureSessionCookie = "__Host-workagent-session"
const developmentSessionCookie = "workagent-session"

type Server struct {
	store         *store.Store
	runtimes      runtimeapi.EmployeeRuntimeRouter
	now           func() time.Time
	secure        bool
	dummyHash     string
	sessionLife   time.Duration
	modules       Modules
	sharedEvents  *sharedEventHub
	migrationJobs *migrationJobTracker
	personalTasks *personalTaskService
	loginSlots    chan struct{}
	apps          *applicationGateway
}

type ModelAccessPort interface {
	ListAuthorized(context.Context, string) ([]contracts.AuthorizedModel, error)
}

type QuotaUsagePort interface {
	Usage(context.Context, string, string, time.Time) (contracts.QuotaUsage, error)
	// GatewayUsage returns the authoritative daily/weekly token usage drained
	// from the model gateway by the Employee Manager.
	GatewayUsage(context.Context, string, time.Time) (contracts.GatewayUsage, error)
}

type SpeechQuotaPort interface {
	ReserveSpeech(context.Context, string, string, int64) error
	SettleSpeech(context.Context, string, int64) error
}

// SharedRunQuotaPort reserves shared AI run quota against the frozen payer SID
// (the member who mentioned the assistant) before the owner Runtime starts.
type SharedRunQuotaPort interface {
	ReserveSharedRun(context.Context, contracts.SharedRunQuotaRequest) error
	// ReleaseSharedRun settles the reservation with zero usage when the run
	// never reached the owner Runtime, so the admission reservation cannot
	// leak in the reserved state.
	ReleaseSharedRun(context.Context, string, string) error
	PendingSharedRuns(context.Context) ([]contracts.PendingQuotaRun, error)
	RecoverSharedRunAuthorization(context.Context, contracts.SharedRunIdentity) error
	ReconcileSettlements(context.Context) error
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
	List(context.Context, contracts.AuditQuery) ([]contracts.AuditEvent, error)
}

type Modules struct {
	SoftwareVersion      string
	PublishedApps        PublishedAppsConfig
	AcpCatalog           *acpcatalog.Store
	Feedback             *feedback.Store
	ChatGPTPro           ChatGPTProPort
	RequestSource        RequestSourcePolicy
	LoginPolicy          store.LoginPolicy
	ProfessionalDatabase ProfessionalDatabasePort
	Storage              StoragePort
	ModelAccess          ModelAccessPort
	Quota                QuotaUsagePort
	SpeechQuota          SpeechQuotaPort
	SharedRunQuota       SharedRunQuotaPort
	Speech               SpeechPort
	Settings             SettingsPort
	SkillMarket          SkillMarketPort
	Marketplace          *marketplace.Store
	Collaboration        CollaborationPort
	SharedProjects       SharedProjectPlatformPort
	SharedFiles          SharedFilePlatformPort
	SharedTrash          SharedTrashPort
	SharedTurns          SharedTurnRunner
	PersonalTaskRuntime  PersonalTaskRuntime
	ChatForward          ChatForwardPort
	IM                   IMPort
	Notifications        NotificationsPort
	Audit                AuditPort
	EmployeeManagement   EmployeeManagementPort
}

func New(data *store.Store, runtimes runtimeapi.EmployeeRuntimeRouter, secure bool) (*Server, error) {
	return NewWithModules(data, runtimes, secure, Modules{})
}

func NewWithModules(data *store.Store, runtimes runtimeapi.EmployeeRuntimeRouter, secure bool, modules Modules) (*Server, error) {
	if data == nil || runtimes == nil {
		return nil, errors.New("store and runtime router are required")
	}
	if modules.Speech != nil && modules.Speech.Capability().Enabled && modules.SpeechQuota == nil {
		return nil, errors.New("enabled speech adapter requires SpeechQuotaPort")
	}
	if err := contracts.ValidateModuleGraph(platformModuleManifests()); err != nil {
		return nil, err
	}
	dummyHash, err := auth.HashPassword([]byte("disabled-account-dummy-password"))
	if err != nil {
		return nil, err
	}
	server := &Server{store: data, runtimes: runtimes, now: time.Now, secure: secure, dummyHash: dummyHash, sessionLife: 12 * time.Hour, modules: modules, sharedEvents: newSharedEventHub(), migrationJobs: newMigrationJobTracker()}
	if modules.Collaboration != nil {
		runtime := modules.PersonalTaskRuntime
		if runtime == nil {
			runtime = newRuntimePersonalTasks(runtimes)
		}
		server.personalTasks = &personalTaskService{store: modules.Collaboration, runtime: runtime, users: data}
	}
	server.loginSlots = make(chan struct{}, 1)
	if modules.PublishedApps.Store != nil {
		u, err := url.Parse(modules.PublishedApps.PublicURL)
		if err != nil || u.Scheme != "http" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("published applications require a public HTTP origin")
		}
		server.apps = &applicationGateway{s: server, config: modules.PublishedApps, listeners: map[string]*http.Server{}, tickets: map[string]appGrant{}, grants: map[string]appGrant{}}
	}
	if server.modules.LoginPolicy.Window == 0 {
		server.modules.LoginPolicy = store.DefaultLoginPolicy()
	}
	return server, nil
}

func (s *Server) Handler() http.Handler {
	return s.HandlerWithWeb(http.NotFoundHandler())
}

func (s *Server) HandlerWithWeb(web http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /apps/{id}", s.applicationEntry)
	mux.HandleFunc("GET /api/portal/apps", s.requireUser(s.publishedAppsHTTP))
	mux.HandleFunc("POST /api/portal/apps", s.requireUser(s.publishedAppsHTTP))
	mux.HandleFunc("GET /api/portal/apps/{id}", s.requireUser(s.publishedAppsHTTP))
	mux.HandleFunc("POST /api/portal/apps/{id}/open", s.requireUser(s.applicationOpen))
	mux.HandleFunc("POST /api/portal/apps/{id}/{action}", s.requireUser(s.publishedAppsHTTP))
	mux.HandleFunc("GET /api/portal/admin/acp-catalog", s.requireUser(s.requireAdmin(s.adminAcpCatalog)))
	mux.HandleFunc("PATCH /api/portal/admin/acp-catalog/{id}", s.requireUser(s.requireAdmin(s.adminAcpCatalog)))
	mux.HandleFunc("POST /api/system/feedback", s.requireUser(s.feedbackHTTP))
	mux.HandleFunc("GET /api/system/feedback", s.requireUser(s.feedbackHTTP))
	mux.HandleFunc("GET /api/admin/feedback/backup", s.requireUser(s.requireAdmin(s.feedbackBackup)))
	mux.HandleFunc("GET /api/portal/apps/{id}/status", s.requireUser(s.applicationStatus))
	mux.HandleFunc("GET /api/system/feedback/{id}", s.requireUser(s.feedbackHTTP))
	mux.HandleFunc("PATCH /api/system/feedback/{id}", s.requireUser(s.feedbackHTTP))
	mux.HandleFunc("GET /api/system/feedback/{id}/attachments/{attachment}", s.requireUser(s.feedbackHTTP))
	mux.HandleFunc("GET /api/portal/me/chatgpt/quota", s.requireUser(s.chatGPTProUsage))
	mux.HandleFunc("GET /api/portal/admin/chatgpt/quotas", s.requireUser(s.chatGPTProUsage))
	mux.HandleFunc("POST /api/portal/admin/chatgpt/quotas", s.requireUser(s.adminChatGPTPro))
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("GET /api/auth/remembered", s.rememberedLogin)
	mux.HandleFunc("DELETE /api/auth/remembered", s.forgetLogin)
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
	mux.HandleFunc("GET /api/portal/admin/quotas", s.requireUser(s.adminQuotas))
	mux.HandleFunc("GET /api/quota/dollars", s.requireUser(s.dollarBudgets))
	mux.HandleFunc("GET /api/portal/admin/usage", s.requireUser(s.dollarUsage))
	mux.HandleFunc("POST /api/portal/admin/quotas", s.requireUser(s.adminQuotas))
	mux.HandleFunc("POST /api/portal/admin/users/{action}", s.requireUser(s.requireAdmin(s.adminUserAction)))
	mux.HandleFunc("POST /api/portal/admin/users/kimi-datasource", s.requireUser(s.requireAdmin(s.adminKimiDatasource)))
	mux.HandleFunc("POST /api/portal/admin/marketplace/professional-database", s.requireUser(s.requireAdmin(s.publishProfessionalDatabase)))
	mux.HandleFunc("GET /api/portal/admin/audit", s.requireUser(s.adminAuditEvents))
	mux.HandleFunc("GET /api/portal/admin/audit/export", s.requireUser(s.adminAuditExport))
	mux.HandleFunc("GET /api/portal/admin/migrations", s.requireUser(s.adminMigrations))
	mux.HandleFunc("GET /api/portal/admin/migration-jobs", s.requireUser(s.adminMigrationJob))
	mux.HandleFunc("POST /api/portal/admin/migrations/{id}/retry", s.requireUser(s.adminMigrationRetry))
	mux.HandleFunc("POST /api/portal/admin/migrations/{id}/resolve", s.requireUser(s.adminMigrationResolve))
	mux.HandleFunc("POST /api/portal/admin/migrations/{id}/reauthorize", s.requireUser(s.adminMigrationReauthorize))
	mux.HandleFunc("GET /api/portal/me/notifications/stream", s.requireUser(s.notificationStream))
	mux.HandleFunc("POST /api/portal/me/notifications/{id}/read", s.requireUser(s.readNotification))
	mux.HandleFunc("POST /api/portal/me/notifications/{id}/acknowledge", s.requireUser(s.acknowledgeNotification))
	mux.HandleFunc("GET /api/system/status", s.requireUser(s.systemStatus))
	mux.HandleFunc("GET /api/system/capabilities", s.requireUser(s.systemCapabilities))
	mux.HandleFunc("GET /api/system/diagnostics", s.requireUser(s.systemDiagnostics))
	mux.HandleFunc("POST /api/system/runtime/restart", s.requireUser(s.restartRuntime))
	mux.HandleFunc("GET /api/system/storage", s.requireUser(s.storageUsage))
	mux.HandleFunc("PUT /api/portal/admin/storage", s.requireUser(s.requireAdmin(s.adminStorage)))
	mux.HandleFunc("GET /api/portal/admin/storage", s.requireUser(s.requireAdmin(s.adminStorage)))
	mux.HandleFunc("GET /api/models", s.requireUser(s.models))
	mux.HandleFunc("GET /api/quota/usage", s.requireUser(s.quotaUsage))
	mux.HandleFunc("GET /api/quota/gateway-usage", s.requireUser(s.gatewayUsage))
	mux.HandleFunc("GET /api/speech/capability", s.requireUser(s.speechCapability))
	mux.HandleFunc("GET /api/settings/client", s.requireUser(s.clientSettings))
	mux.HandleFunc("PUT /api/settings/client", s.requireUser(s.updateClientSettings))
	mux.HandleFunc("GET /api/skill-market", s.requireUser(s.skillMarket))
	mux.HandleFunc("GET /api/portal/skill-market", s.requireUser(s.skillMarket))
	mux.HandleFunc("GET /api/portal/marketplace", s.requireUser(s.marketCatalog))
	mux.HandleFunc("DELETE /api/portal/marketplace", s.requireUser(s.marketCatalog))
	mux.HandleFunc("POST /api/portal/marketplace", s.requireUser(s.publishMarketEntry))
	mux.HandleFunc("POST /api/portal/marketplace/install", s.requireUser(s.installMarketEntry))
	mux.HandleFunc("GET /api/portal/marketplace/versions", s.requireUser(s.marketVersions))
	mux.HandleFunc("POST /api/portal/marketplace/update", s.requireUser(s.marketUpdate))
	mux.HandleFunc("GET /api/portal/admin/marketplace", s.requireUser(s.requireAdmin(s.adminMarket)))
	mux.HandleFunc("POST /api/portal/admin/marketplace", s.requireUser(s.requireAdmin(s.adminMarket)))
	mux.HandleFunc("GET /api/portal/shared-projects/{id}/capabilities", s.requireUser(s.projectSubscriptions))
	mux.HandleFunc("POST /api/portal/shared-projects/{id}/capabilities", s.requireUser(s.projectSubscriptions))
	mux.HandleFunc("DELETE /api/portal/shared-projects/{id}/capabilities", s.requireUser(s.projectSubscriptions))
	mux.HandleFunc("GET /api/portal/projects/{id}/capabilities", s.requireUser(s.personalProjectSubscriptions))
	mux.HandleFunc("POST /api/portal/projects/{id}/capabilities", s.requireUser(s.personalProjectSubscriptions))
	mux.HandleFunc("DELETE /api/portal/projects/{id}/capabilities", s.requireUser(s.personalProjectSubscriptions))
	mux.HandleFunc("POST /api/portal/skill-market", s.requireUser(s.publishMarketSkill))
	mux.HandleFunc("POST /api/portal/skill-market/install", s.requireUser(s.installMarketSkill))
	mux.HandleFunc("DELETE /api/portal/skill-market", s.requireUser(s.deleteMarketSkill))
	mux.HandleFunc("GET /api/portal/shared-projects", s.requireUser(s.sharedProjects))
	mux.HandleFunc("POST /api/portal/shared-projects", s.requireUser(s.sharedProjects))
	mux.HandleFunc("PATCH /api/portal/shared-projects/{id}", s.requireUser(s.sharedProject))
	mux.HandleFunc("GET /api/portal/shared-projects/{id}/members", s.requireUser(s.sharedProjectMembers))
	mux.HandleFunc("GET /api/portal/shared-projects/{id}/assistants", s.requireUser(s.sharedAssistantMembers))
	mux.HandleFunc("GET /api/portal/shared-projects/{id}/assistant-options", s.requireUser(s.sharedAssistantOptions))
	mux.HandleFunc("POST /api/portal/shared-projects/{id}/assistant-invites", s.requireUser(s.sharedAssistantInvite))
	mux.HandleFunc("PATCH /api/portal/shared-projects/{id}/assistants/{assistantID}", s.requireUser(s.sharedAssistantSettings))
	mux.HandleFunc("DELETE /api/portal/shared-projects/{id}/assistants/{assistantID}", s.requireUser(s.sharedAssistantSettings))
	mux.HandleFunc("POST /api/portal/shared-projects/{id}/discussion", s.requireUser(s.sharedDefaultDiscussion))
	mux.HandleFunc("GET /api/portal/shared-projects/{id}/invites", s.requireUser(s.sharedOutgoingInvites))
	mux.HandleFunc("DELETE /api/portal/shared-invites/{id}", s.requireUser(s.sharedRevokeInvite))
	mux.HandleFunc("PUT /api/portal/shared-conversations/{id}/assistant", s.requireUser(s.sharedBindAssistant))
	mux.HandleFunc("POST /api/portal/shared-projects/{id}/invites", s.requireUser(s.sharedProjectInvites))
	mux.HandleFunc("POST /api/portal/shared-projects/{id}/invite-links", s.requireUser(s.sharedProjectInviteLinkCreate))
	mux.HandleFunc("DELETE /api/portal/shared-projects/{id}/invite-links/{token}", s.requireUser(s.sharedProjectInviteLinkRevoke))
	mux.HandleFunc("POST /api/portal/shared-invite-links/accept", s.requireUser(s.sharedInviteLinkAccept))
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
	mux.HandleFunc("GET /api/portal/shared-personal-tasks", s.requireUser(s.personalTaskOperations))
	mux.HandleFunc("POST /api/portal/shared-personal-tasks", s.requireUser(s.personalTaskOperations))
	mux.HandleFunc("DELETE /api/portal/shared-personal-tasks", s.requireUser(s.personalTaskOperations))
	mux.HandleFunc("POST /api/portal/shared-conversations", s.requireUser(s.sharedConversations))
	mux.HandleFunc("PATCH /api/portal/shared-conversations", s.requireUser(s.sharedConversations))
	mux.HandleFunc("DELETE /api/portal/shared-conversations", s.requireUser(s.sharedConversations))
	mux.HandleFunc("GET /api/portal/shared-messages", s.requireUser(s.sharedMessages))
	mux.HandleFunc("POST /api/portal/shared-messages", s.requireUser(s.sharedMessages))
	mux.HandleFunc("POST /api/portal/shared-runs/cancel", s.requireUser(s.cancelSharedRun))
	mux.HandleFunc("GET /api/portal/shared-events", s.requireUser(s.sharedEventStream))
	mux.HandleFunc("POST /api/portal/shared-files", s.requireUser(s.sharedFiles))
	mux.HandleFunc("/api/portal/shared-workspaces/{id}/{rest...}", s.requireUser(s.sharedWorkspaceHTTP))
	mux.HandleFunc("POST /api/portal/shared-office-preview", s.requireUser(s.sharedOfficePreview))
	mux.HandleFunc("GET /api/portal/shared-office-preview", s.requireUser(s.sharedOfficePreviewContent))
	mux.HandleFunc("POST /api/stt", s.requireUser(s.speech))
	mux.HandleFunc("GET /api/stt/stream", s.requireUser(s.speech))
	mux.HandleFunc("/api/runtime/", s.requireUser(s.proxyRuntime))
	// The official Harness client owns its own /api RPC namespace. Portal's
	// explicit APIs above remain authoritative; unmatched /api requests are
	// forwarded to the SID-private runtime with the internal bearer injected.
	mux.HandleFunc("/api/", s.requireUser(s.proxyDsh))
	mux.Handle("/", s.webSurface(web))
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
		SID:     user.SID,
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
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionSkillMarketPublish, id, nil, map[string]string{"skill_name": metadata.Name, "version": metadata.Version})
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
	if s.modules.Marketplace != nil {
		if err = s.importLegacyMarket(request.Context(), user); err != nil {
			marketError(writer, err)
			return
		}
		s.modules.Marketplace.InstallMu.Lock()
		defer s.modules.Marketplace.InstallMu.Unlock()
		if _, _, err = s.modules.Marketplace.Get(request.Context(), "legacy-"+input.ID); err != nil {
			marketError(writer, err)
			return
		}
	}
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
	// The UserHost records the runtime-side skill.install event; this records
	// the market install request itself, correlated to the same request.
	var installErr error
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		installErr = errors.New("skill market install rejected: " + strconv.Itoa(response.StatusCode))
	}
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionSkillMarketInstall, pack.ID, installErr, map[string]string{"skill_name": pack.Name, "version": pack.Version})
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
	s.recordBusinessEvent(request.Context(), user.Username, audit.ActionSkillMarketDelete, id, nil, nil)
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
		cookie, err := uniqueCookie(request, s.cookieName())
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
		if strings.HasPrefix(request.URL.Path, "/api/runtime/") || (strings.HasPrefix(request.URL.Path, "/api/") && !strings.HasPrefix(request.URL.Path, "/api/portal/")) {
			if err := s.applyMarketActions(request.Context(), user); err != nil {
				writeError(writer, 503, "market_security_update_pending")
				return
			}
		}
		sharedMutation := s.modules.Collaboration != nil && strings.HasPrefix(request.URL.Path, "/api/portal/shared-") && request.Method != http.MethodGet && request.Method != http.MethodHead && !strings.HasSuffix(request.URL.Path, "shared-messages") && !strings.HasSuffix(request.URL.Path, "shared-office-preview")
		if strings.Contains(request.URL.Path, "/uploads") && !strings.HasSuffix(request.URL.Path, "/complete") {
			sharedMutation = false
		}
		if sharedMutation {
			audience := s.sharedRefreshAudience(request.Context(), user.ID)
			defer func() {
				for id := range s.sharedRefreshAudience(request.Context(), user.ID) {
					audience[id] = true
				}
				for id := range audience {
					s.sharedEvents.publish(collaboration.Message{Kind: "refresh", AuthorUserID: &id})
				}
			}()
		}
		next(writer, request, user)
	}
}

func (s *Server) login(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Username      string `json:"username"`
		Password      string `json:"password"`
		Remember      bool   `json:"remember"`
		UseRemembered bool   `json:"useRemembered"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 4*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || auth.ValidateUsername(input.Username) != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	markAudit(request, input.Username, false)
	finish, admitted := s.beginLogin(writer, request, input.Username)
	if !admitted {
		return
	}
	defer finish()
	var user store.User
	if input.UseRemembered {
		var err error
		user, err = s.rememberedUser(request)
		if err != nil || !strings.EqualFold(user.Username, input.Username) || input.Password != "" {
			if !s.recordLogin(writer, request, input.Username, false) {
				return
			}
			writeError(writer, http.StatusUnauthorized, "invalid_credentials")
			return
		}
	} else {
		var lookupErr error
		user, lookupErr = s.store.UserByUsername(request.Context(), input.Username)
		encoded := s.dummyHash
		if lookupErr == nil {
			encoded = user.PasswordHash
		}
		valid := auth.VerifyPassword(encoded, []byte(input.Password))
		if lookupErr != nil || !valid || user.Disabled {
			if !s.recordLogin(writer, request, input.Username, false) {
				return
			}
			writeError(writer, http.StatusUnauthorized, "invalid_credentials")
			return
		}
	}
	if !s.recordLogin(writer, request, input.Username, true) {
		return
	}
	token, err := auth.RandomToken(32)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	lifetime := s.sessionLife
	if input.Remember {
		lifetime = 30 * 24 * time.Hour
	}
	expires := s.now().Add(lifetime)
	if err := s.store.CreateSession(request.Context(), token, user.ID, expires); err != nil {
		log.Printf("create Portal login session: %v", err)
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	cookie := &http.Cookie{Name: s.cookieName(), Value: token, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode}
	if input.Remember {
		cookie.Expires = expires
		cookie.MaxAge = int(lifetime.Seconds())
	}
	http.SetCookie(writer, cookie)
	if !input.UseRemembered || !input.Remember {
		if err := s.saveRememberedLogin(writer, request, user, input.Remember); err != nil {
			writer.Header().Del("Set-Cookie")
			_ = s.store.DeleteSession(request.Context(), token)
			writeError(writer, http.StatusInternalServerError, "internal_error")
			return
		}
	}
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
	finish, admitted := s.beginLogin(writer, request, input.Username)
	if !admitted {
		return
	}
	defer finish()
	user, lookupErr := s.store.UserByUsername(request.Context(), input.Username)
	encoded := s.dummyHash
	if lookupErr == nil {
		encoded = user.PasswordHash
	}
	if !auth.VerifyPassword(encoded, []byte(input.CurrentPassword)) || lookupErr != nil || user.Disabled {
		if !s.recordLogin(writer, request, input.Username, false) {
			return
		}
		writePasswordChangeError(writer, http.StatusUnauthorized, "INVALID_CURRENT_PASSWORD")
		return
	}
	if !s.recordLogin(writer, request, input.Username, true) {
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
	cookie, _ := uniqueCookie(request, s.cookieName())
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

// gatewayUsage serves the authoritative daily/weekly token usage drained from
// the model gateway, shown on the usage page next to the internal run records.
func (s *Server) gatewayUsage(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Quota == nil {
		writeError(writer, http.StatusServiceUnavailable, "quota_unavailable")
		return
	}
	usage, err := s.modules.Quota.GatewayUsage(request.Context(), user.SID, s.now())
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
	capability := s.modules.Speech.Capability()
	if !capability.Enabled {
		writeError(writer, http.StatusServiceUnavailable, "speech_disabled")
		return
	}
	estimatedSeconds := capability.MaxStreamSeconds
	if estimatedSeconds < 1 {
		estimatedSeconds = 1
	}
	runID := "speech-" + CorrelationID(request.Context())
	if err := s.modules.SpeechQuota.ReserveSpeech(request.Context(), user.SID, runID, estimatedSeconds); err != nil {
		writeSpeechQuotaError(writer, err)
		return
	}
	started := s.now()
	s.modules.Speech.ServeSpeech(writer, request, user.SID)
	elapsed := s.now().Sub(started)
	actualSeconds := int64((elapsed + time.Second - 1) / time.Second)
	if actualSeconds < 1 {
		actualSeconds = 1
	}
	if actualSeconds > estimatedSeconds {
		actualSeconds = estimatedSeconds
	}
	// A failed settlement conservatively leaves the reservation open, so a
	// metering outage cannot turn into unaccounted speech usage.
	_ = s.modules.SpeechQuota.SettleSpeech(context.WithoutCancel(request.Context()), runID, actualSeconds)
}

func writeSpeechQuotaError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, contracts.ErrQuotaExceeded):
		writeError(writer, http.StatusTooManyRequests, "quota_exceeded")
	case errors.Is(err, contracts.ErrModelUnauthorized):
		writeError(writer, http.StatusForbidden, "model_not_authorized")
	case errors.Is(err, contracts.ErrQuotaNotConfigured):
		writeError(writer, http.StatusConflict, "quota_not_configured")
	default:
		writeError(writer, http.StatusServiceUnavailable, "speech_quota_unavailable")
	}
}

func (s *Server) proxyRuntime(writer http.ResponseWriter, request *http.Request, user store.User) {
	s.proxyRuntimePath(writer, request, user, "/api/runtime/")
}

func (s *Server) proxyDsh(writer http.ResponseWriter, request *http.Request, user store.User) {
	s.proxyRuntimePath(writer, request, user, "")
}

func (s *Server) proxyRuntimePath(writer http.ResponseWriter, request *http.Request, user store.User, stripPrefix string) {
	forwardPath := "/" + strings.TrimPrefix(strings.TrimPrefix(request.URL.Path, stripPrefix), "/")
	if strings.HasPrefix(forwardPath, "/internal/") || forwardPath == "/internal" || strings.HasPrefix(forwardPath, "/v1/published-apps/") {
		writeError(writer, 403, "internal_route_forbidden")
		return
	}
	if s.interceptPersonalTaskDeletion(writer, request, user) {
		return
	}
	if tracker, ok := s.runtimes.(interface{ BeginRequest(string) (func(), error) }); ok {
		done, err := tracker.BeginRequest(user.SID)
		if err != nil {
			writeError(writer, 503, "runtime_unavailable")
			return
		}
		defer done()
	}
	endpoint, err := s.runtimes.Resolve(request.Context(), user.SID)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "runtime_unavailable")
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(endpoint.BaseURL)
	if stripPrefix == "" {
		proxy.ModifyResponse = brandDshResponse
	}
	original := proxy.Director
	proxy.Director = func(outgoing *http.Request) {
		original(outgoing)
		if stripPrefix == "" && dshBrandingDocument(outgoing.URL.Path) {
			outgoing.Header.Set("Accept-Encoding", "identity")
			outgoing.Header.Del("If-None-Match")
			outgoing.Header.Del("If-Modified-Since")
		}
		// Browser Origin and ownership were validated before entering this
		// proxy. Internal services trust the loopback authority of this hop;
		// preserve the public authority separately for OAuth redirects below.
		outgoing.Host = endpoint.BaseURL.Host
		if outgoing.Header.Get("Origin") != "" {
			outgoing.Header.Set("Origin", endpoint.BaseURL.Scheme+"://"+endpoint.BaseURL.Host)
		}
		if stripPrefix != "" {
			outgoing.URL.Path = "/" + strings.TrimPrefix(request.URL.Path, stripPrefix)
		}
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

const frontendCookie = "workagent_frontend"

// webSurface keeps the login, password, administrator and OAuth pages on the
// Portal client, while an authenticated employee gets the official dsh SPA.
// A cookie-backed query switch is intentionally retained for one release so
// all of the old client's absolute asset URLs continue to resolve together.
func (s *Server) webSurface(legacy http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/guid" && request.URL.Query().Get("open") == "shared-invites" {
			http.Redirect(writer, request, "/?frontend=dsh&workagent=shared&view=invites", http.StatusTemporaryRedirect)
			return
		}
		if request.URL.Path == "/" {
			// The same URL serves login or DSH according to the session cookie.
			// Never reuse one surface's document after login or logout.
			writer.Header().Set("Cache-Control", "no-store")
			request = request.Clone(request.Context())
			request.Header.Del("If-Modified-Since")
			request.Header.Del("If-None-Match")
		}
		variant := request.URL.Query().Get("frontend")
		if variant == "legacy" || variant == "dsh" {
			value, maxAge := variant, 30*24*60*60
			if variant == "dsh" {
				value, maxAge = "", -1
			}
			http.SetCookie(writer, &http.Cookie{Name: frontendCookie, Value: value, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
		}
		if variant == "legacy" || strings.HasPrefix(request.URL.Path, "/admin/") || request.URL.Path == "/oauth/mcp/callback" {
			if variant == "" {
				http.SetCookie(writer, &http.Cookie{Name: frontendCookie, Value: "legacy", Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode, MaxAge: 30 * 24 * 60 * 60})
			}
			legacy.ServeHTTP(writer, request)
			return
		}
		if cookie, err := request.Cookie(frontendCookie); err == nil && cookie.Value == "legacy" && variant != "dsh" {
			legacy.ServeHTTP(writer, request)
			return
		}
		cookie, err := uniqueCookie(request, s.cookieName())
		if err != nil {
			legacy.ServeHTTP(writer, request)
			return
		}
		user, err := s.store.UserBySession(request.Context(), cookie.Value, s.now())
		if err != nil {
			legacy.ServeHTTP(writer, request)
			return
		}
		markAudit(request, user.Username, false)
		s.proxyDsh(writer, request, user)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		frameAncestors := "'none'"
		previewPath := strings.ToLower(request.URL.Query().Get("path"))
		workspacePDFPreview := (strings.HasPrefix(request.URL.Path, "/api/runtime/v1/workspaces/") || strings.HasPrefix(request.URL.Path, "/api/portal/shared-workspaces/")) && strings.HasSuffix(request.URL.Path, "/content") && request.URL.Query().Get("preview") == "1" && strings.HasSuffix(previewPath, ".pdf")
		// Converted Office previews are PDFs rendered in the same sandboxed
		// iframe pipeline, so they get the same frame-ancestors exception.
		officePreview := strings.HasPrefix(request.URL.Path, "/api/runtime/v1/office-preview/content/") || request.URL.Path == "/api/portal/shared-office-preview"
		if request.Method == http.MethodGet && (workspacePDFPreview || officePreview) {
			frameAncestors = "'self'"
		}
		policy := "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors " + frameAncestors + "; base-uri 'none'"
		if s.dshDocument(request) {
			// The official dsh client bootstraps its module loader inline and its
			// runtime compiles bundled client modules with Function. Keep these
			// allowances scoped to authenticated dsh documents; Portal-owned login,
			// administrator, OAuth and legacy pages retain the stricter policy.
			policy = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'"
		}
		writer.Header().Set("Content-Security-Policy", policy)
		if s.dshDocument(request) && s.apps != nil {
			u, _ := url.Parse(s.apps.config.PublicURL)
			policy += "; frame-src 'self' http://" + u.Hostname() + ":*"
			writer.Header().Set("Content-Security-Policy", policy)
		}
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) dshDocument(request *http.Request) bool {
	if request.Method != http.MethodGet || request.URL.Path != "/" {
		return false
	}
	if _, err := uniqueCookie(request, s.cookieName()); err != nil {
		return false
	}
	variant := request.URL.Query().Get("frontend")
	if variant == "legacy" {
		return false
	}
	if variant == "dsh" {
		return true
	}
	cookie, err := request.Cookie(frontendCookie)
	return err != nil || cookie.Value != "legacy"
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
