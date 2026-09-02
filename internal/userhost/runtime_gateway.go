package userhost

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/credentialbroker"
	"workagent3/internal/managedskills"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/nativeauth"
	"workagent3/internal/skillmigration"
	"workagent3/internal/skillruntime"
)

type runtimeGateway struct {
	server        *http.Server
	catalog       *mcpruntime.Catalog
	credentials   *credentialbroker.Store
	skills        *skillruntime.Store
	migration     *skillmigration.Store
	oauth         *mcpOAuthManager
	cancelRefresh context.CancelFunc
	// deliver performs the Harness-facing startup round-trips (MCP/Provider/
	// Skill/Preset projections and, for a staged bundle, the final consume).
	// It runs after the listener and lease are up so a slow or cold Harness
	// cannot blind the local runtime API — the migration journal included —
	// for minutes after every restart. A delivery failure still fails the
	// runtime, preserving the ordered-delivery fail-closed semantics.
	deliver func(context.Context) error
}

func newRuntimeGateway(runtimeDirectory, dshHome, managedSkillsRoot string, managedMCPServers []mcpruntime.Server, managedToolsRoot, dataRoot, ownerSID string, target *url.URL, token string, bundle *nativeauth.Bundle, auditSink *auditClient, restart func(), assigners ...mcpProcessAssigner) (*runtimeGateway, error) {
	catalog, err := mcpruntime.Open(filepath.Join(runtimeDirectory, "mcp-catalog.db"))
	if err != nil {
		return nil, err
	}
	if managedMCPServers != nil {
		if err := catalog.SyncManaged(context.Background(), managedMCPServers); err != nil {
			catalog.Close()
			return nil, err
		}
	}
	credentials, err := credentialbroker.Open(filepath.Join(runtimeDirectory, "credential-broker.db"), credentialbroker.NewUserProtector())
	if err != nil {
		catalog.Close()
		return nil, err
	}
	skills, err := skillruntime.Open(filepath.Join(runtimeDirectory, "skill-catalog.db"), filepath.Join(runtimeDirectory, "skills"))
	if err != nil {
		credentials.Close()
		catalog.Close()
		return nil, err
	}
	if managedSkillsRoot != "" {
		if err := managedskills.Sync(context.Background(), managedSkillsRoot, skills); err != nil {
			skills.Close()
			credentials.Close()
			catalog.Close()
			return nil, err
		}
	}
	migration, err := skillmigration.Open(filepath.Join(runtimeDirectory, "skill-migration.db"), skills, nil)
	if err != nil {
		skills.Close()
		credentials.Close()
		catalog.Close()
		return nil, err
	}
	publisher := &harnessProjectionPublisher{catalog: catalog, credentials: credentials, target: target, token: token, client: &http.Client{Timeout: 5 * time.Second}}
	providerPublisher := &harnessProviderCredentialPublisher{credentials: credentials, target: target, token: token, client: &http.Client{Timeout: 5 * time.Second}}
	if bundle != nil {
		// Ordered delivery step 2: the Harness shares the same SID-private
		// ChatGPT downstream key as native Codex. The key travels only through
		// this UserHost-internal path into the SID Credential Broker; Portal and
		// the browser never see the plaintext.
		secret := []byte(bundle.CodexAPIKey)
		_, err := credentials.Put(context.Background(), credentialbroker.Input{
			ID: managedHarnessProviderCredentialID, Kind: credentialbroker.KindProvider, Label: "Harness managed Provider", Secret: secret, State: credentialbroker.StateReady,
		})
		clearBytes(secret)
		if err != nil {
			migration.Close()
			skills.Close()
			credentials.Close()
			catalog.Close()
			return nil, fmt.Errorf("store managed Harness Provider credential: %w", err)
		}
	}
	skillPublisher := &harnessSkillProjectionPublisher{store: skills, target: target, token: token, client: &http.Client{Timeout: 5 * time.Second}}
	presetPublisher := &harnessPresetMigrationPublisher{path: filepath.Join(dshHome, "workagent", "preset-migration.json"), target: target, token: token, client: &http.Client{Timeout: 5 * time.Second}, migration: migration}
	deliver := func(ctx context.Context) error {
		if err := publisher.Publish(ctx); err != nil {
			return err
		}
		// Ordered delivery step 3: re-project the managed Provider into the
		// running Harness so it switches to the new key without a restart.
		if err := providerPublisher.Publish(ctx); err != nil {
			return err
		}
		if err := skillPublisher.Publish(ctx); err != nil {
			return err
		}
		if err := presetPublisher.Publish(ctx); err != nil {
			return err
		}
		if bundle != nil {
			// Ordered delivery steps 2 and 3 completed; only now is the bundle
			// consumed, so a failed delivery is replayed on the next start.
			if err := nativeauth.Consume(dataRoot); err != nil {
				return err
			}
		}
		return nil
	}
	oauth := newMCPOAuthManager(catalog, credentials, publisher, auditSink)
	refreshContext, cancelRefresh := context.WithCancel(context.Background())
	go oauth.runRefresher(refreshContext)
	sharedProjects, err := NewSharedProjectManager(dataRoot, ownerSID)
	if err != nil {
		cancelRefresh()
		migration.Close()
		skills.Close()
		credentials.Close()
		catalog.Close()
		return nil, err
	}
	sharedFiles, err := newSharedFileManager(dataRoot, ownerSID)
	if err != nil {
		cancelRefresh()
		migration.Close()
		skills.Close()
		credentials.Close()
		catalog.Close()
		return nil, err
	}
	var assigner mcpProcessAssigner
	if len(assigners) > 0 {
		assigner = assigners[0]
	}
	officePreview, err := newOfficePreviewService(filepath.Join(dataRoot, "cache", "office-pdf"), managedToolsRoot, assigner)
	if err != nil {
		cancelRefresh()
		migration.Close()
		skills.Close()
		credentials.Close()
		catalog.Close()
		return nil, err
	}
	sharedFiles.officePreview = officePreview
	handler := newRuntimeGatewayHandlerWithControl(catalog, credentials, publisher, skills, skillPublisher, migration, oauth, target, token, runtimeSharedProjectOperator{sharedProjects}, sharedFiles, officePreview, filepath.Join(dataRoot, "workspace"), restart, auditSink, presetPublisher, assigners...)
	return &runtimeGateway{server: &http.Server{Handler: handler}, catalog: catalog, credentials: credentials, skills: skills, migration: migration, oauth: oauth, cancelRefresh: cancelRefresh, deliver: deliver}, nil
}

func (g *runtimeGateway) Close() error {
	if g.cancelRefresh != nil {
		g.cancelRefresh()
	}
	serverErr := g.server.Close()
	catalogErr := g.catalog.Close()
	credentialErr := g.credentials.Close()
	skillErr := g.skills.Close()
	migrationErr := g.migration.Close()
	if serverErr != nil && !errors.Is(serverErr, http.ErrServerClosed) {
		return serverErr
	}
	if catalogErr != nil {
		return catalogErr
	}
	if credentialErr != nil {
		return credentialErr
	}
	if skillErr != nil {
		return skillErr
	}
	return migrationErr
}

type credentialCatalog interface {
	ListMetadata(context.Context) ([]credentialbroker.Metadata, error)
	Metadata(context.Context, string) (credentialbroker.Metadata, error)
}

type runtimeCredentialCatalog interface {
	credentialCatalog
	projectionCredentialResolver
	Put(context.Context, credentialbroker.Input) (credentialbroker.Metadata, error)
	Resolve(context.Context, string) ([]byte, error)
	Revoke(context.Context, string) error
}

func newRuntimeGatewayHandler(catalog *mcpruntime.Catalog, credentials runtimeCredentialCatalog, publisher mcpProjectionPublisher, skills *skillruntime.Store, skillPublisher skillProjectionPublisher, migration *skillmigration.Store, oauth *mcpOAuthManager, target *url.URL, token string, assigners ...mcpProcessAssigner) http.Handler {
	return newRuntimeGatewayHandlerWithShared(catalog, credentials, publisher, skills, skillPublisher, migration, oauth, target, token, nil, assigners...)
}

func newRuntimeGatewayHandlerWithShared(catalog *mcpruntime.Catalog, credentials runtimeCredentialCatalog, publisher mcpProjectionPublisher, skills *skillruntime.Store, skillPublisher skillProjectionPublisher, migration *skillmigration.Store, oauth *mcpOAuthManager, target *url.URL, token string, sharedProjects sharedProjectOperator, assigners ...mcpProcessAssigner) http.Handler {
	return newRuntimeGatewayHandlerWithControl(catalog, credentials, publisher, skills, skillPublisher, migration, oauth, target, token, sharedProjects, nil, nil, "", nil, nil, nil, assigners...)
}

func newRuntimeGatewayHandlerWithControl(catalog *mcpruntime.Catalog, credentials runtimeCredentialCatalog, publisher mcpProjectionPublisher, skills *skillruntime.Store, skillPublisher skillProjectionPublisher, migration *skillmigration.Store, oauth *mcpOAuthManager, target *url.URL, token string, sharedProjects sharedProjectOperator, sharedFiles sharedFileOperator, officePreview *officePreviewService, workspaceRoot string, restart func(), auditSink *auditClient, presetPublisher *harnessPresetMigrationPublisher, assigners ...mcpProcessAssigner) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(target)
	providerPublisher := &harnessProviderCredentialPublisher{credentials: credentials, target: target, token: token, client: &http.Client{Timeout: 5 * time.Second}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/system/status", runtimeSystemStatus(target, token))
	mux.HandleFunc("POST /v1/system/restart", runtimeSystemRestart(restart))
	mux.HandleFunc("GET /v1/credentials", listCredentialStatuses(credentials, target, token))
	mux.HandleFunc("POST /v1/credentials", createCredential(credentials))
	mux.HandleFunc("DELETE /v1/credentials/{id}", revokeCredential(credentials, publisher))
	// The managed Harness Provider key is owned by the UserHost-internal
	// delivery path (see newRuntimeGateway); the browser gets status and health
	// only, never a write route.
	mux.HandleFunc("POST /v1/provider-credentials/harness/test", testManagedProvider(providerPublisher))
	mux.HandleFunc("GET /v1/mcp-servers", listMCPServers(catalog, credentials))
	mux.HandleFunc("POST /v1/mcp-servers", createMCPServer(catalog, credentials, publisher, auditSink))
	mux.HandleFunc("PATCH /v1/mcp-servers/{id}", updateMCPServer(catalog, credentials, publisher, auditSink))
	mux.HandleFunc("DELETE /v1/mcp-servers/{id}", deleteMCPServer(catalog, publisher, auditSink))
	mux.HandleFunc("POST /v1/mcp-servers/{id}/test", testMCPConnection(catalog, credentials, publisher, assigners...))
	mux.HandleFunc("GET /v1/skills", listSkills(skills))
	mux.HandleFunc("GET /v1/skills/export", exportUserSkill(skills))
	mux.HandleFunc("GET /v1/skills/{id}", getSkill(skills))
	mux.HandleFunc("PATCH /v1/skills/{id}", updateSkill(skills, skillPublisher, auditSink))
	mux.HandleFunc("DELETE /v1/skills/{id}", deleteSkill(skills, skillPublisher, auditSink))
	mux.HandleFunc("POST /v1/skills/market-install", installMarketSkill(skills, skillPublisher, auditSink))
	if migration != nil {
		mux.HandleFunc("GET /v1/migrations/skills-mcp", listSkillMCPMigration(migration))
		mux.HandleFunc("POST /v1/migrations/retry", retryMigration(migration, catalog, credentials, publisher, skillPublisher, presetPublisher))
		mux.HandleFunc("POST /v1/migrations/resolve", resolveMigration(migration))
	}
	if oauth != nil {
		mux.HandleFunc("POST /v1/mcp-servers/{id}/oauth/start", startMCPOAuth(oauth))
		mux.HandleFunc("POST /v1/mcp-servers/{id}/oauth/complete", completeMCPOAuth(oauth, auditSink))
		mux.HandleFunc("DELETE /v1/mcp-servers/{id}/oauth", logoutMCPOAuth(oauth, auditSink))
	}
	if sharedProjects != nil {
		mux.HandleFunc("PUT /internal/shared-projects/{id}", sharedProjectPlatformHandler(sharedProjects))
	}
	if sharedFiles != nil {
		mux.HandleFunc("POST /internal/shared-files", sharedFileHandler(sharedFiles))
		if projects, ok := sharedFiles.(sharedTurnProjectResolver); ok {
			mux.HandleFunc("POST /internal/shared-turns", sharedTurnHandler(projects, target, token))
			mux.HandleFunc("POST /internal/shared-turns/{id}/cancel", sharedTurnCancelHandler(target, token))
		}
	}
	if officePreview != nil {
		mux.HandleFunc("POST /v1/office-preview/convert", officePreviewConvertHandler(officePreview, workspaceRoot))
		mux.HandleFunc("GET /v1/office-preview/content/{name}", officePreviewContentHandler(officePreview))
	}
	mux.HandleFunc("/internal/", func(writer http.ResponseWriter, _ *http.Request) {
		writeRuntimeError(writer, http.StatusNotFound, "not_found")
	})
	mux.Handle("/", proxy)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		provided, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			writeRuntimeError(writer, http.StatusUnauthorized, "runtime_authentication_required")
			return
		}
		mux.ServeHTTP(writer, request)
	})
}

func runtimeSystemStatus(target *url.URL, token string) http.HandlerFunc {
	client := &http.Client{Timeout: 2 * time.Second}
	return func(writer http.ResponseWriter, request *http.Request) {
		healthURL := target.ResolveReference(&url.URL{Path: "/health"})
		probe, _ := http.NewRequestWithContext(request.Context(), http.MethodGet, healthURL.String(), nil)
		probe.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(probe)
		status := "unhealthy"
		if err == nil {
			response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				status = "healthy"
			}
		}
		writeRuntimeJSON(writer, http.StatusOK, map[string]any{"components": []map[string]string{{"id": "userhost", "status": "healthy"}, {"id": "harness", "status": status}}})
	}
}

func runtimeSystemRestart(restart func()) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		if restart == nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "runtime_restart_unavailable")
			return
		}
		writeRuntimeJSON(writer, http.StatusAccepted, map[string]any{"accepted": true})
		time.AfterFunc(100*time.Millisecond, restart)
	}
}

func startMCPOAuth(manager *mcpOAuthManager) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input struct {
			RedirectURI string `json:"redirectUri"`
		}
		decoder := json.NewDecoder(io.LimitReader(request.Body, 16*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || !redirectMatchesRequest(input.RedirectURI, request) {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_oauth_redirect_uri")
			return
		}
		result, err := manager.start(request.Context(), request.PathValue("id"), input.RedirectURI)
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, result)
	}
}

func completeMCPOAuth(manager *mcpOAuthManager, auditSink *auditClient) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input struct {
			FlowID string `json:"flowId"`
			State  string `json:"state"`
			Code   string `json:"code"`
		}
		decoder := json.NewDecoder(io.LimitReader(request.Body, 32*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_oauth_callback")
			return
		}
		if err := manager.complete(request.Context(), request.PathValue("id"), input.FlowID, input.State, input.Code); err != nil {
			auditSink.Record(request.Context(), audit.ActionMCPOAuthAuthorize, request.PathValue("id"), "failure", requestCorrelationID(request), nil)
			writeRuntimeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		server, err := manager.catalog.Get(request.Context(), request.PathValue("id"))
		if err != nil {
			writeRuntimeError(writer, http.StatusNotFound, "mcp_server_not_found")
			return
		}
		auditSink.Record(request.Context(), audit.ActionMCPOAuthAuthorize, server.ID, "success", requestCorrelationID(request), map[string]string{"server_name": server.Name})
		writeRuntimeJSON(writer, http.StatusOK, server)
	}
}

func logoutMCPOAuth(manager *mcpOAuthManager, auditSink *auditClient) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if err := manager.logout(request.Context(), request.PathValue("id")); err != nil {
			auditSink.Record(request.Context(), audit.ActionMCPOAuthRevoke, request.PathValue("id"), "failure", requestCorrelationID(request), nil)
			writeRuntimeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		auditSink.Record(request.Context(), audit.ActionMCPOAuthRevoke, request.PathValue("id"), "success", requestCorrelationID(request), nil)
		writer.WriteHeader(http.StatusNoContent)
	}
}

func redirectMatchesRequest(raw string, request *http.Request) bool {
	redirect, err := url.Parse(raw)
	if err != nil || redirect.Host == "" || redirect.Path != "/oauth/mcp/callback" || redirect.RawQuery != "" || redirect.Fragment != "" {
		return false
	}
	expectedHost := request.Header.Get("X-Forwarded-Host")
	if expectedHost == "" {
		expectedHost = request.Host
	}
	expectedScheme := request.Header.Get("X-Forwarded-Proto")
	if expectedScheme == "" {
		expectedScheme = request.URL.Scheme
	}
	if expectedScheme == "" {
		expectedScheme = "http"
	}
	return strings.EqualFold(redirect.Host, expectedHost) && strings.EqualFold(redirect.Scheme, expectedScheme)
}

func listSkillMCPMigration(migration *skillmigration.Store) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		skills, err := migration.Results(request.Context())
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "migration_journal_failed")
			return
		}
		mcp, err := migration.MCPResults(request.Context())
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "migration_journal_failed")
			return
		}
		presets, err := migration.PresetResults(request.Context())
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "migration_journal_failed")
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, map[string]any{"results": append(append(mcp, skills...), presets...)})
	}
}

func createCredential(credentials runtimeCredentialCatalog) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input struct {
			Kind   credentialbroker.Kind `json:"kind"`
			Label  string                `json:"label"`
			Secret string                `json:"secret"`
		}
		decoder := json.NewDecoder(io.LimitReader(request.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || (input.Kind != credentialbroker.KindMCPHeader && input.Kind != credentialbroker.KindMCPEnv) ||
			strings.TrimSpace(input.Label) == "" || input.Secret == "" || len(input.Secret) > 32*1024 || strings.IndexByte(input.Secret, 0) >= 0 {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_credential")
			return
		}
		id, err := auth.RandomToken(18)
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "credential_broker_failed")
			return
		}
		secret := []byte(input.Secret)
		metadata, err := credentials.Put(request.Context(), credentialbroker.Input{
			ID: id, Kind: input.Kind, Label: input.Label, Secret: secret, State: credentialbroker.StateReady,
		})
		clearBytes(secret)
		input.Secret = ""
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_credential")
			return
		}
		writeRuntimeJSON(writer, http.StatusCreated, metadata)
	}
}

func testManagedProvider(tester providerHealthTester) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		health, err := tester.Test(request.Context())
		if err != nil {
			writeRuntimeError(writer, http.StatusBadGateway, "provider_health_failed")
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, health)
	}
}

func revokeCredential(credentials runtimeCredentialCatalog, publisher mcpProjectionPublisher) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		metadata, err := credentials.Metadata(request.Context(), request.PathValue("id"))
		if errors.Is(err, credentialbroker.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "credential_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "credential_broker_failed")
			return
		}
		if metadata.Kind != credentialbroker.KindMCPHeader && metadata.Kind != credentialbroker.KindMCPEnv && metadata.Kind != credentialbroker.KindMCPOAuth {
			writeRuntimeError(writer, http.StatusForbidden, "native_credential_read_only")
			return
		}
		if err := credentials.Revoke(request.Context(), metadata.ID); err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "credential_broker_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "mcp_projection_failed")
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	}
}

func listSkills(skills *skillruntime.Store) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		entries, err := skills.List(request.Context())
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_catalog_failed")
			return
		}
		resolved := make([]resolvedSkillEntry, 0, len(entries))
		for _, entry := range entries {
			resolved = append(resolved, resolveSkillEntry(entry, exec.LookPath))
		}
		writeRuntimeJSON(writer, http.StatusOK, resolved)
	}
}

func getSkill(skills *skillruntime.Store) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		entry, err := skills.Get(request.Context(), request.PathValue("id"))
		if errors.Is(err, skillruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "skill_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_catalog_failed")
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, resolveSkillEntry(entry, exec.LookPath))
	}
}

func updateSkill(skills *skillruntime.Store, publisher skillProjectionPublisher, auditSink *auditClient) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input struct {
			Enabled *bool `json:"enabled"`
		}
		decoder := json.NewDecoder(io.LimitReader(request.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || input.Enabled == nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_enabled_state")
			return
		}
		if *input.Enabled {
			current, err := skills.Get(request.Context(), request.PathValue("id"))
			if errors.Is(err, skillruntime.ErrNotFound) {
				writeRuntimeError(writer, http.StatusNotFound, "skill_not_found")
				return
			}
			if err != nil {
				writeRuntimeError(writer, http.StatusInternalServerError, "skill_catalog_failed")
				return
			}
			resolved := resolveSkillEntry(current, exec.LookPath)
			if resolved.Health != "ready" {
				writeRuntimeError(writer, http.StatusConflict, "skill_dependency_unavailable:"+resolved.UnavailableReason)
				return
			}
		}
		action := audit.ActionSkillDisable
		if *input.Enabled {
			action = audit.ActionSkillEnable
		}
		entry, err := skills.SetEnabled(request.Context(), request.PathValue("id"), *input.Enabled)
		if errors.Is(err, skillruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "skill_not_found")
			return
		}
		if err != nil {
			auditSink.Record(request.Context(), action, request.PathValue("id"), "failure", requestCorrelationID(request), nil)
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_catalog_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "skill_projection_failed")
			return
		}
		auditSink.Record(request.Context(), action, entry.ID, "success", requestCorrelationID(request), map[string]string{"skill_name": entry.Name})
		writeRuntimeJSON(writer, http.StatusOK, resolveSkillEntry(entry, exec.LookPath))
	}
}

func deleteSkill(skills *skillruntime.Store, publisher skillProjectionPublisher, auditSink *auditClient) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		entry, err := skills.Get(request.Context(), request.PathValue("id"))
		if errors.Is(err, skillruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "skill_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_catalog_failed")
			return
		}
		if entry.Source != "user" && entry.Source != "market" {
			writeRuntimeError(writer, http.StatusForbidden, "managed_skill_read_only")
			return
		}
		if err := skills.Remove(request.Context(), entry.ID); err != nil {
			auditSink.Record(request.Context(), audit.ActionSkillUninstall, entry.ID, "failure", requestCorrelationID(request), map[string]string{"skill_name": entry.Name})
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_catalog_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "skill_projection_failed")
			return
		}
		auditSink.Record(request.Context(), audit.ActionSkillUninstall, entry.ID, "success", requestCorrelationID(request), map[string]string{"skill_name": entry.Name, "source": entry.Source})
		writer.WriteHeader(http.StatusNoContent)
	}
}

func listCredentialStatuses(credentials credentialCatalog, target *url.URL, token string) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		brokerStatuses, err := credentials.ListMetadata(request.Context())
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "credential_broker_failed")
			return
		}
		downstreamURL := target.ResolveReference(&url.URL{Path: "/v1/credentials"})
		downstreamRequest, err := http.NewRequestWithContext(request.Context(), http.MethodGet, downstreamURL.String(), nil)
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "credential_status_failed")
			return
		}
		downstreamRequest.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(downstreamRequest)
		if err != nil {
			writeRuntimeError(writer, http.StatusBadGateway, "credential_status_failed")
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			writeRuntimeError(writer, http.StatusBadGateway, "credential_status_failed")
			return
		}
		var statuses []json.RawMessage
		if json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&statuses) != nil {
			writeRuntimeError(writer, http.StatusBadGateway, "credential_status_failed")
			return
		}
		for _, status := range brokerStatuses {
			encoded, _ := json.Marshal(status)
			statuses = append(statuses, encoded)
		}
		writeRuntimeJSON(writer, http.StatusOK, statuses)
	}
}

func listMCPServers(catalog *mcpruntime.Catalog, credentials credentialCatalog) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		servers, err := catalog.List(request.Context())
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		for index := range servers {
			if !validCredentialReferences(request.Context(), credentials, servers[index].Transport) {
				servers[index].OAuthState = "needs_auth"
			}
		}
		writeRuntimeJSON(writer, http.StatusOK, servers)
	}
}

func createMCPServer(catalog *mcpruntime.Catalog, credentials credentialCatalog, publisher mcpProjectionPublisher, auditSink *auditClient) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input mcpMutation
		decoder := json.NewDecoder(io.LimitReader(request.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || input.Name == nil || input.Transport == nil || input.Enabled == nil ||
			input.ToolPolicy == nil || input.AllowedTools == nil || input.Source == nil || *input.Source != "user" ||
			input.OAuthState == nil || *input.OAuthState != "none" {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		if !validCredentialReferences(request.Context(), credentials, *input.Transport) {
			writeRuntimeError(writer, http.StatusBadRequest, "credential_reference_not_found")
			return
		}
		id, err := auth.RandomToken(18)
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		health := "unknown"
		if input.Transport.Kind == "stdio" {
			health = "needs_review"
		}
		server, err := catalog.Create(request.Context(), mcpruntime.Server{
			ID: id, Name: *input.Name, Description: valueOrEmpty(input.Description), Source: "user", Enabled: *input.Enabled,
			Transport: *input.Transport, ToolPolicy: *input.ToolPolicy, AllowedTools: *input.AllowedTools,
			OAuthState: "none", Health: health,
		})
		if err != nil {
			auditSink.Record(request.Context(), audit.ActionMCPInstall, id, "failure", requestCorrelationID(request), map[string]string{"server_name": *input.Name})
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "mcp_projection_failed")
			return
		}
		auditSink.Record(request.Context(), audit.ActionMCPInstall, server.ID, "success", requestCorrelationID(request), map[string]string{"server_name": server.Name, "transport": server.Transport.Kind})
		writeRuntimeJSON(writer, http.StatusCreated, server)
	}
}

func updateMCPServer(catalog *mcpruntime.Catalog, credentials credentialCatalog, publisher mcpProjectionPublisher, auditSink *auditClient) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		server, err := catalog.Get(request.Context(), request.PathValue("id"))
		if errors.Is(err, mcpruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "mcp_server_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		if server.Source != "user" {
			writeRuntimeError(writer, http.StatusForbidden, "managed_mcp_read_only")
			return
		}
		var input mcpMutation
		decoder := json.NewDecoder(io.LimitReader(request.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || (input.Source != nil && *input.Source != "user") ||
			(input.OAuthState != nil && *input.OAuthState != server.OAuthState) || input.Health != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		if input.Name != nil {
			server.Name = *input.Name
		}
		if input.Description != nil {
			server.Description = *input.Description
		}
		auditAction := audit.ActionMCPUpdate
		if input.Enabled != nil && *input.Enabled != server.Enabled {
			auditAction = audit.ActionMCPEnable
			if !*input.Enabled {
				auditAction = audit.ActionMCPDisable
			}
		}
		if input.Enabled != nil {
			server.Enabled = *input.Enabled
		}
		if input.Transport != nil {
			if !validCredentialReferences(request.Context(), credentials, *input.Transport) {
				writeRuntimeError(writer, http.StatusBadRequest, "credential_reference_not_found")
				return
			}
			server.Transport = *input.Transport
			server.Health = "unknown"
			if server.Transport.Kind == "stdio" {
				server.Health = "needs_review"
			}
		}
		if input.ToolPolicy != nil {
			server.ToolPolicy = *input.ToolPolicy
		}
		if input.AllowedTools != nil {
			server.AllowedTools = *input.AllowedTools
		}
		server, err = catalog.Replace(request.Context(), server)
		if err != nil {
			auditSink.Record(request.Context(), auditAction, request.PathValue("id"), "failure", requestCorrelationID(request), map[string]string{"server_name": server.Name})
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "mcp_projection_failed")
			return
		}
		auditSink.Record(request.Context(), auditAction, server.ID, "success", requestCorrelationID(request), map[string]string{"server_name": server.Name})
		writeRuntimeJSON(writer, http.StatusOK, server)
	}
}

func validCredentialReferences(ctx context.Context, credentials credentialCatalog, transport mcpruntime.Transport) bool {
	for _, id := range transport.EnvironmentCredentialIDs {
		metadata, err := credentials.Metadata(ctx, id)
		if err != nil || metadata.Kind != credentialbroker.KindMCPEnv || metadata.State != credentialbroker.StateReady {
			return false
		}
	}
	for _, id := range transport.HeaderCredentialIDs {
		metadata, err := credentials.Metadata(ctx, id)
		if err != nil || (metadata.Kind != credentialbroker.KindMCPHeader && metadata.Kind != credentialbroker.KindMCPOAuth) || metadata.State != credentialbroker.StateReady {
			return false
		}
	}
	return true
}

func deleteMCPServer(catalog *mcpruntime.Catalog, publisher mcpProjectionPublisher, auditSink *auditClient) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		server, err := catalog.Get(request.Context(), request.PathValue("id"))
		if errors.Is(err, mcpruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "mcp_server_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		if server.Source != "user" {
			writeRuntimeError(writer, http.StatusForbidden, "managed_mcp_read_only")
			return
		}
		if err := catalog.Delete(request.Context(), server.ID); err != nil {
			auditSink.Record(request.Context(), audit.ActionMCPUninstall, server.ID, "failure", requestCorrelationID(request), map[string]string{"server_name": server.Name})
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "mcp_projection_failed")
			return
		}
		auditSink.Record(request.Context(), audit.ActionMCPUninstall, server.ID, "success", requestCorrelationID(request), map[string]string{"server_name": server.Name})
		writer.WriteHeader(http.StatusNoContent)
	}
}

type mcpMutation struct {
	Name         *string               `json:"name"`
	Description  *string               `json:"description"`
	Source       *string               `json:"source"`
	Enabled      *bool                 `json:"enabled"`
	Transport    *mcpruntime.Transport `json:"transport"`
	ToolPolicy   *string               `json:"toolPolicy"`
	AllowedTools *[]string             `json:"allowedTools"`
	OAuthState   *string               `json:"oauthState"`
	Health       *string               `json:"health"`
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func writeRuntimeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeRuntimeError(writer http.ResponseWriter, status int, code string) {
	writeRuntimeJSON(writer, status, map[string]string{"error": code})
}
