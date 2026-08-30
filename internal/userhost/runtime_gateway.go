package userhost

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/credentialbroker"
	"workagent3/internal/managedskills"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillmigration"
	"workagent3/internal/skillruntime"
)

type runtimeGateway struct {
	server      *http.Server
	catalog     *mcpruntime.Catalog
	credentials *credentialbroker.Store
	skills      *skillruntime.Store
	migration   *skillmigration.Store
	oauth       *mcpOAuthManager
}

func newRuntimeGateway(runtimeDirectory, managedSkillsRoot string, target *url.URL, token string, assigners ...mcpProcessAssigner) (*runtimeGateway, error) {
	catalog, err := mcpruntime.Open(filepath.Join(runtimeDirectory, "mcp-catalog.db"))
	if err != nil {
		return nil, err
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
	if err := publisher.Publish(context.Background()); err != nil {
		migration.Close()
		skills.Close()
		credentials.Close()
		catalog.Close()
		return nil, err
	}
	skillPublisher := &harnessSkillProjectionPublisher{store: skills, target: target, token: token, client: &http.Client{Timeout: 5 * time.Second}}
	if err := skillPublisher.Publish(context.Background()); err != nil {
		migration.Close()
		skills.Close()
		credentials.Close()
		catalog.Close()
		return nil, err
	}
	oauth := newMCPOAuthManager(catalog, credentials, publisher)
	handler := newRuntimeGatewayHandler(catalog, credentials, publisher, skills, skillPublisher, migration, oauth, target, token, assigners...)
	return &runtimeGateway{server: &http.Server{Handler: handler}, catalog: catalog, credentials: credentials, skills: skills, migration: migration, oauth: oauth}, nil
}

func (g *runtimeGateway) Close() error {
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
	Revoke(context.Context, string) error
}

func newRuntimeGatewayHandler(catalog *mcpruntime.Catalog, credentials runtimeCredentialCatalog, publisher mcpProjectionPublisher, skills *skillruntime.Store, skillPublisher skillProjectionPublisher, migration *skillmigration.Store, oauth *mcpOAuthManager, target *url.URL, token string, assigners ...mcpProcessAssigner) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(target)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/credentials", listCredentialStatuses(credentials, target, token))
	mux.HandleFunc("POST /v1/credentials", createCredential(credentials))
	mux.HandleFunc("DELETE /v1/credentials/{id}", revokeCredential(credentials, publisher))
	mux.HandleFunc("GET /v1/mcp-servers", listMCPServers(catalog, credentials))
	mux.HandleFunc("POST /v1/mcp-servers", createMCPServer(catalog, credentials, publisher))
	mux.HandleFunc("PATCH /v1/mcp-servers/{id}", updateMCPServer(catalog, credentials, publisher))
	mux.HandleFunc("DELETE /v1/mcp-servers/{id}", deleteMCPServer(catalog, publisher))
	mux.HandleFunc("POST /v1/mcp-servers/{id}/test", testMCPConnection(catalog, credentials, publisher, assigners...))
	mux.HandleFunc("GET /v1/skills", listSkills(skills))
	mux.HandleFunc("GET /v1/skills/export", exportUserSkill(skills))
	mux.HandleFunc("GET /v1/skills/{id}", getSkill(skills))
	mux.HandleFunc("PATCH /v1/skills/{id}", updateSkill(skills, skillPublisher))
	mux.HandleFunc("DELETE /v1/skills/{id}", deleteSkill(skills, skillPublisher))
	mux.HandleFunc("POST /v1/skills/market-install", installMarketSkill(skills, skillPublisher))
	if migration != nil {
		mux.HandleFunc("GET /v1/migrations/skills-mcp", listSkillMCPMigration(migration))
	}
	if oauth != nil {
		mux.HandleFunc("POST /v1/mcp-servers/{id}/oauth/start", startMCPOAuth(oauth))
		mux.HandleFunc("POST /v1/mcp-servers/{id}/oauth/complete", completeMCPOAuth(oauth))
		mux.HandleFunc("DELETE /v1/mcp-servers/{id}/oauth", logoutMCPOAuth(oauth))
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

func completeMCPOAuth(manager *mcpOAuthManager) http.HandlerFunc {
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
			writeRuntimeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		server, err := manager.catalog.Get(request.Context(), request.PathValue("id"))
		if err != nil {
			writeRuntimeError(writer, http.StatusNotFound, "mcp_server_not_found")
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, server)
	}
}

func logoutMCPOAuth(manager *mcpOAuthManager) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if err := manager.logout(request.Context(), request.PathValue("id")); err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, err.Error())
			return
		}
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
		writeRuntimeJSON(writer, http.StatusOK, map[string]any{"results": append(mcp, skills...)})
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
		writeRuntimeJSON(writer, http.StatusOK, entries)
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
		writeRuntimeJSON(writer, http.StatusOK, entry)
	}
}

func updateSkill(skills *skillruntime.Store, publisher skillProjectionPublisher) http.HandlerFunc {
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
		entry, err := skills.SetEnabled(request.Context(), request.PathValue("id"), *input.Enabled)
		if errors.Is(err, skillruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "skill_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_catalog_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "skill_projection_failed")
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, entry)
	}
}

func deleteSkill(skills *skillruntime.Store, publisher skillProjectionPublisher) http.HandlerFunc {
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
			writeRuntimeError(writer, http.StatusInternalServerError, "skill_catalog_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "skill_projection_failed")
			return
		}
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

func createMCPServer(catalog *mcpruntime.Catalog, credentials credentialCatalog, publisher mcpProjectionPublisher) http.HandlerFunc {
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
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "mcp_projection_failed")
			return
		}
		writeRuntimeJSON(writer, http.StatusCreated, server)
	}
}

func updateMCPServer(catalog *mcpruntime.Catalog, credentials credentialCatalog, publisher mcpProjectionPublisher) http.HandlerFunc {
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
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "mcp_projection_failed")
			return
		}
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

func deleteMCPServer(catalog *mcpruntime.Catalog, publisher mcpProjectionPublisher) http.HandlerFunc {
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
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		if err := publisher.Publish(request.Context()); err != nil {
			writeRuntimeError(writer, http.StatusServiceUnavailable, "mcp_projection_failed")
			return
		}
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
