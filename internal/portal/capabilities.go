package portal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

func platformModuleManifests() []contracts.ModuleManifest {
	dependency := func(id, contract string) contracts.ModuleDependency {
		return contracts.ModuleDependency{ID: id, Contract: contract}
	}
	manifest := func(id, layer, owner, health string, capabilities []string, dependencies ...contracts.ModuleDependency) contracts.ModuleManifest {
		return contracts.ModuleManifest{
			ID: id, Version: "1.0.0", Layer: layer, Required: true,
			Capabilities: capabilities, Dependencies: dependencies,
			DataOwner: owner, HealthCheck: health,
		}
	}
	return []contracts.ModuleManifest{
		manifest("portal-auth", "platform", "central users and browser sessions", "/api/auth/me", []string{"auth.password", "auth.session", "auth.profile"}),
		manifest("employee-management", "adapter", "central employee lifecycle state", "/api/portal/admin/users", []string{"employee.lifecycle", "employee.windows-account", "employee.runtime-repair"}, dependency("portal-auth", "AuthenticatedAdminPort/v1")),
		manifest("runtime-router", "platform", "runtime registration credentials and SID routing", "/api/system/status", []string{"runtime.route", "runtime.status", "runtime.restart"}, dependency("portal-auth", "AuthenticatedSIDPort/v1")),
		manifest("model-access", "platform", "central model catalog, grants and downstream keys", "/api/models", []string{"model.catalog", "model.authorization", "model.downstream-key"}),
		manifest("quota", "platform", "central budgets and idempotent reservations", "/api/quota/usage", []string{"quota.usage", "quota.reserve", "quota.settle", "quota.gateway-usage"}, dependency("model-access", "ModelCatalogPort/v1")),
		manifest("settings", "platform", "central user client settings", "/api/settings/client", []string{"settings.appearance", "settings.language", "settings.defaults"}, dependency("portal-auth", "AuthenticatedUserPort/v1")),
		manifest("notifications", "platform", "central notifications and per-user receipts", "/api/portal/me/notifications", []string{"notification.publish", "notification.read", "notification.stream"}, dependency("portal-auth", "AuthenticatedUserPort/v1")),
		manifest("audit", "platform", "append-only security and management audit", "/api/portal/admin/audit", []string{"audit.record", "audit.query", "audit.export"}, dependency("portal-auth", "AuditIdentityPort/v1")),
		manifest("skill-market", "platform", "central reviewed Skill packages", "/api/skill-market", []string{"skill-market.publish", "skill-market.review", "skill-market.install"}, dependency("portal-auth", "PublisherIdentityPort/v1"), dependency("runtime-router", "SkillInstallPort/v1")),
		manifest("collaboration", "platform", "central shared projects, membership, messages and runs", "/api/portal/shared-projects", []string{"collaboration.projects", "collaboration.members", "collaboration.messages", "collaboration.runs"}, dependency("portal-auth", "CollaborationIdentityPort/v1"), dependency("runtime-router", "OwnerRuntimePort/v1")),
		manifest("chatforward", "adapter", "delegation metadata only", "/chatgpt/", []string{"chatforward.delegate"}, dependency("portal-auth", "DelegatedIdentityPort/v1"), dependency("model-access", "ModelAuthorizationPort/v1")),
		manifest("im-gateway", "adapter", "connector configuration, pairing and delivery receipts", "/api/channels/", []string{"im.connectors", "im.pairing", "im.delivery"}, dependency("portal-auth", "PairingIdentityPort/v1"), dependency("runtime-router", "InboxDeliveryPort/v1")),
		manifest("speech", "adapter", "none; same-origin stream proxy only", "/api/speech/capability", []string{"speech.capability", "speech.stream"}, dependency("portal-auth", "AuthenticatedUserPort/v1"), dependency("quota", "QuotaPort/v1")),
		manifest("observability", "platform", "redacted diagnostics only", "/api/system/diagnostics", []string{"system.health", "system.diagnostics", "system.correlation"}, dependency("audit", "AuditPort/v1"), dependency("runtime-router", "RuntimeStatusPort/v1")),
		manifest("operations", "platform", "owner-scoped backup and restore journals", "workagent://health/operations", []string{"backup.create", "backup.restore", "migration.inventory"}, dependency("audit", "AuditPort/v1")),
		manifest("release", "platform", "component releases and activation journal", "workagent://health/release", []string{"release.stage", "release.activate", "release.rollback"}, dependency("operations", "BackupReadinessPort/v1"), dependency("notifications", "NotificationPort/v1")),
		manifest("capability-read-model", "platform", "none; read-only manifest aggregation", "/api/system/capabilities", []string{"capability.modules", "capability.health", "capability.risk"}, dependency("runtime-router", "RuntimeCapabilityPort/v1"), dependency("observability", "SystemStatusPort/v1")),
	}
}

func (s *Server) platformModuleReadModel() []contracts.ModuleReadModelEntry {
	configured := func(value bool) string {
		if value {
			return "healthy"
		}
		return "disabled"
	}
	speechConfigured := s.modules.Speech != nil && s.modules.SpeechQuota != nil && s.modules.Speech.Capability().Enabled
	statuses := map[string]string{
		"portal-auth": "healthy", "runtime-router": "healthy", "observability": "healthy",
		"capability-read-model": "healthy",
		"operations":            "unknown",
		"release":               "unknown",
		"employee-management":   configured(s.modules.EmployeeManagement != nil),
		"model-access":          configured(s.modules.ModelAccess != nil),
		"quota":                 configured(s.modules.Quota != nil),
		"settings":              configured(s.modules.Settings != nil),
		"notifications":         configured(s.modules.Notifications != nil),
		"audit":                 configured(s.modules.Audit != nil),
		"skill-market":          configured(s.modules.SkillMarket != nil),
		"collaboration": configured(s.modules.Collaboration != nil && s.modules.SharedProjects != nil &&
			s.modules.SharedFiles != nil && s.modules.SharedTurns != nil),
		"chatforward": configured(s.modules.ChatForward != nil),
		"im-gateway":  configured(s.modules.IM != nil),
		"speech":      configured(speechConfigured),
	}
	manifests := platformModuleManifests()
	entries := make([]contracts.ModuleReadModelEntry, 0, len(manifests))
	for _, manifest := range manifests {
		entries = append(entries, contracts.ModuleReadModelEntry{Manifest: manifest, Status: statuses[manifest.ID]})
	}
	return entries
}

func (s *Server) systemCapabilities(writer http.ResponseWriter, request *http.Request, user store.User) {
	writeJSON(writer, http.StatusOK, s.collectCapabilityReadModel(request.Context(), user))
}

func (s *Server) collectCapabilityReadModel(ctx context.Context, user store.User) contracts.CapabilityReadModel {
	result := contracts.CapabilityReadModel{
		SchemaVersion: 1, PlatformModules: s.platformModuleReadModel(),
		RuntimeModules: []contracts.ModuleManifest{}, RuntimeStatus: "unavailable", Engines: map[string]contracts.EngineCapabilities{},
	}
	endpoint, err := s.runtimes.Resolve(ctx, user.SID)
	if err != nil {
		return result
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/v1/capabilities"})
	downstream, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	downstream.Header.Set("Authorization", "Bearer "+endpoint.Token)
	setCorrelationHeader(downstream)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(downstream)
	if err != nil {
		result.RuntimeStatus = "unhealthy"
		return result
	}
	defer response.Body.Close()
	var runtime struct {
		Modules []contracts.ModuleManifest              `json:"modules"`
		Engines map[string]contracts.EngineCapabilities `json:"engines"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&runtime) != nil || len(runtime.Modules) == 0 || contracts.ValidateModuleGraph(runtime.Modules) != nil || !validEngineCapabilityKeys(runtime.Engines) {
		result.RuntimeStatus = "unhealthy"
		return result
	}
	result.RuntimeStatus = "healthy"
	result.RuntimeModules = runtime.Modules
	if runtime.Engines != nil {
		result.Engines = runtime.Engines
	}
	return result
}

func validEngineCapabilityKeys(engines map[string]contracts.EngineCapabilities) bool {
	for id := range engines {
		if id != "harness" && id != "codex" && id != "kimi" {
			return false
		}
	}
	return true
}
