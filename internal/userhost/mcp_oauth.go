package userhost

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
)

const (
	oauthFlowLifetime = 10 * time.Minute
	// Refresh starts when the access token expires within the skew window; the
	// scan runs on a fixed interval because the Harness talks to MCP servers
	// directly, so UserHost never sees an on-demand 401 to react to.
	oauthRefreshSkew         = 2 * time.Minute
	oauthRefreshScanInterval = time.Minute
)

var errOAuthGrantInvalid = errors.New("oauth_refresh_grant_invalid")

type mcpOAuthManager struct {
	catalog      *mcpruntime.Catalog
	credentials  *credentialbroker.Store
	publisher    mcpProjectionPublisher
	audit        *auditClient
	client       *http.Client
	now          func() time.Time
	allowPrivate bool
	mu           sync.Mutex
	pending      map[string]pendingMCPAuth
	flights      map[string]chan struct{}
}

type pendingMCPAuth struct {
	serverID, resource, redirectURI, clientID, tokenEndpoint, revocationEndpoint, state string
	verifier                                                                            []byte
	expiresAt                                                                           time.Time
}

type oauthStartResult struct {
	AuthorizationURL string    `json:"authorizationUrl"`
	FlowID           string    `json:"flowId"`
	State            string    `json:"state"`
	ExpiresAt        time.Time `json:"expiresAt"`
}

type protectedResourceMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
	ScopesSupported      []string `json:"scopes_supported"`
}

type authorizationServerMetadata struct {
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	RegistrationEndpoint  string   `json:"registration_endpoint"`
	RevocationEndpoint    string   `json:"revocation_endpoint"`
	ScopesSupported       []string `json:"scopes_supported"`
}

func newMCPOAuthManager(catalog *mcpruntime.Catalog, credentials *credentialbroker.Store, publisher mcpProjectionPublisher, audits ...*auditClient) *mcpOAuthManager {
	return &mcpOAuthManager{
		catalog: catalog, credentials: credentials, publisher: publisher, audit: firstAuditClient(audits),
		client: &http.Client{Transport: &http.Transport{DialContext: guardedMCPDialer(false)}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("oauth_redirect_rejected") }, Timeout: 15 * time.Second},
		now:    time.Now, pending: map[string]pendingMCPAuth{}, flights: map[string]chan struct{}{},
	}
}

// firstAuditClient unwraps the optional trailing audit client used by the
// variadic handler/manager constructors.
func firstAuditClient(audits []*auditClient) *auditClient {
	if len(audits) == 0 {
		return nil
	}
	return audits[0]
}

func (m *mcpOAuthManager) start(ctx context.Context, serverID, redirectURI string) (oauthStartResult, error) {
	server, err := m.catalog.Get(ctx, serverID)
	if err != nil {
		return oauthStartResult{}, err
	}
	if server.Transport.Kind != "http" && server.Transport.Kind != "sse" {
		return oauthStartResult{}, errors.New("mcp_oauth_requires_http_transport")
	}
	redirect, err := m.validateURL(redirectURI, true)
	if err != nil {
		return oauthStartResult{}, errors.New("invalid_oauth_redirect_uri")
	}
	resource, err := m.validateURL(server.Transport.URL, false)
	if err != nil {
		return oauthStartResult{}, errors.New("invalid_mcp_endpoint")
	}
	protected, err := m.discoverProtectedResource(ctx, resource)
	if err != nil {
		return oauthStartResult{}, err
	}
	if len(protected.AuthorizationServers) == 0 {
		return oauthStartResult{}, errors.New("oauth_authorization_server_missing")
	}
	authorizationServer, err := m.validateURL(protected.AuthorizationServers[0], false)
	if err != nil {
		return oauthStartResult{}, errors.New("invalid_oauth_authorization_server")
	}
	metadata, err := m.discoverAuthorizationServer(ctx, authorizationServer)
	if err != nil {
		return oauthStartResult{}, err
	}
	authorizationEndpoint, err := m.validateURL(metadata.AuthorizationEndpoint, false)
	if err != nil {
		return oauthStartResult{}, errors.New("invalid_oauth_authorization_endpoint")
	}
	tokenEndpoint, err := m.validateURL(metadata.TokenEndpoint, false)
	if err != nil {
		return oauthStartResult{}, errors.New("invalid_oauth_token_endpoint")
	}
	registrationEndpoint, err := m.validateURL(metadata.RegistrationEndpoint, false)
	if err != nil {
		return oauthStartResult{}, errors.New("oauth_dynamic_registration_required")
	}
	clientID, err := m.registerClient(ctx, registrationEndpoint, redirect.String())
	if err != nil {
		return oauthStartResult{}, err
	}
	verifier, err := oauthRandomBytes(32)
	if err != nil {
		return oauthStartResult{}, err
	}
	flowID, err := auth.RandomToken(24)
	if err != nil {
		return oauthStartResult{}, err
	}
	state, err := auth.RandomToken(24)
	if err != nil {
		return oauthStartResult{}, err
	}
	challenge := sha256.Sum256(verifier)
	scopes := protected.ScopesSupported
	if len(scopes) == 0 {
		scopes = metadata.ScopesSupported
	}
	query := authorizationEndpoint.Query()
	query.Set("response_type", "code")
	query.Set("client_id", clientID)
	query.Set("redirect_uri", redirect.String())
	query.Set("state", state)
	query.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
	query.Set("code_challenge_method", "S256")
	query.Set("resource", resource.String())
	if len(scopes) != 0 {
		query.Set("scope", strings.Join(scopes, " "))
	}
	authorizationEndpoint.RawQuery = query.Encode()
	expiresAt := m.now().Add(oauthFlowLifetime)
	revocationEndpoint := ""
	if metadata.RevocationEndpoint != "" {
		if endpoint, err := m.validateURL(metadata.RevocationEndpoint, false); err == nil {
			revocationEndpoint = endpoint.String()
		}
	}
	m.mu.Lock()
	m.purgeLocked()
	if len(m.pending) >= 32 {
		m.mu.Unlock()
		return oauthStartResult{}, errors.New("too_many_oauth_flows")
	}
	m.pending[flowID] = pendingMCPAuth{serverID: serverID, resource: resource.String(), redirectURI: redirect.String(), clientID: clientID, tokenEndpoint: tokenEndpoint.String(), revocationEndpoint: revocationEndpoint, verifier: verifier, state: state, expiresAt: expiresAt}
	m.mu.Unlock()
	return oauthStartResult{AuthorizationURL: authorizationEndpoint.String(), FlowID: flowID, State: state, ExpiresAt: expiresAt.UTC()}, nil
}

func (m *mcpOAuthManager) complete(ctx context.Context, serverID, flowID, state, code string) error {
	if flowID == "" || state == "" || code == "" || len(code) > 16*1024 {
		return errors.New("invalid_oauth_callback")
	}
	m.mu.Lock()
	m.purgeLocked()
	flow, ok := m.pending[flowID]
	if ok {
		delete(m.pending, flowID)
	}
	m.mu.Unlock()
	if !ok || flow.state != state || flow.serverID != serverID {
		clearBytes(flow.verifier)
		return errors.New("oauth_flow_missing_or_mismatched")
	}
	defer clearBytes(flow.verifier)
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {flow.redirectURI}, "client_id": {flow.clientID},
		"code_verifier": {string(flow.verifier)}, "resource": {flow.resource},
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, flow.tokenEndpoint, strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := m.client.Do(request)
	if err != nil {
		return errors.New("oauth_token_exchange_failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("oauth_token_http_status:%d", response.StatusCode)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if decodeLimitedJSON(response.Body, &token) != nil || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "bearer") || token.ExpiresIn < 0 {
		return errors.New("invalid_oauth_token_response")
	}
	var expiresAt *time.Time
	if token.ExpiresIn > 0 {
		value := m.now().Add(time.Duration(token.ExpiresIn) * time.Second).UTC()
		expiresAt = &value
	}
	credentialID, err := auth.RandomToken(18)
	if err != nil {
		return err
	}
	server, err := m.catalog.Get(ctx, flow.serverID)
	if err != nil {
		return err
	}
	_, err = m.credentials.PutOAuth(ctx, credentialID, server.Name+" OAuth", credentialbroker.OAuthToken{
		AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, TokenType: token.TokenType, ExpiresAt: expiresAt,
		TokenEndpoint: flow.tokenEndpoint, RevocationEndpoint: flow.revocationEndpoint, ClientID: flow.clientID, Resource: flow.resource,
	})
	token.AccessToken, token.RefreshToken = "", ""
	if err != nil {
		return err
	}
	if server.Transport.Kind == "stdio" {
		_ = m.credentials.Revoke(ctx, credentialID)
		return errors.New("mcp_oauth_requires_http_transport")
	}
	if server.Transport.HeaderCredentialIDs == nil {
		server.Transport.HeaderCredentialIDs = map[string]string{}
	}
	// Re-authorization replaces the previous grant: revoke the old credential
	// at the authorization server (best effort) and wipe it locally.
	if oldID := server.Transport.HeaderCredentialIDs["Authorization"]; oldID != "" && oldID != credentialID {
		if oldToken, err := m.credentials.ResolveOAuthToken(ctx, oldID); err == nil {
			m.revokeRemote(ctx, oldToken)
			oldToken.AccessToken, oldToken.RefreshToken = "", ""
		}
		if err := m.credentials.Revoke(ctx, oldID); err != nil && !errors.Is(err, credentialbroker.ErrNotFound) {
			_ = m.credentials.Revoke(ctx, credentialID)
			return err
		}
	}
	server.Transport.HeaderCredentialIDs["Authorization"] = credentialID
	server.OAuthState = "ready"
	server.Health = "unknown"
	if _, err := m.catalog.Replace(ctx, server); err != nil {
		_ = m.credentials.Revoke(ctx, credentialID)
		return err
	}
	return m.publisher.Publish(ctx)
}

func (m *mcpOAuthManager) logout(ctx context.Context, serverID string) error {
	server, err := m.catalog.Get(ctx, serverID)
	if err != nil {
		return err
	}
	if server.Transport.Kind == "stdio" {
		return errors.New("mcp_oauth_requires_http_transport")
	}
	credentialID := server.Transport.HeaderCredentialIDs["Authorization"]
	if credentialID != "" {
		metadata, metadataErr := m.credentials.Metadata(ctx, credentialID)
		if metadataErr == nil && metadata.Kind == credentialbroker.KindMCPOAuth {
			if err := m.credentials.Revoke(ctx, credentialID); err != nil {
				return err
			}
			delete(server.Transport.HeaderCredentialIDs, "Authorization")
		}
	}
	server.OAuthState = "needs_auth"
	server.Health = "unknown"
	if _, err := m.catalog.Replace(ctx, server); err != nil {
		return err
	}
	return m.publisher.Publish(ctx)
}

// runRefresher scans MCP OAuth credentials on a fixed interval and refreshes
// access tokens nearing expiry. A periodic scan is the fitting trigger here:
// the Harness talks to MCP servers directly with projected headers, so
// UserHost never observes an on-demand 401 it could react to.
func (m *mcpOAuthManager) runRefresher(ctx context.Context) {
	ticker := time.NewTicker(oauthRefreshScanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.refreshDue(ctx)
		}
	}
}

// refreshDue performs one scan: every ready HTTP/SSE server whose OAuth
// credential expires within the skew window gets a singleflight refresh.
func (m *mcpOAuthManager) refreshDue(ctx context.Context) {
	servers, err := m.catalog.List(ctx)
	if err != nil {
		return
	}
	for _, server := range servers {
		if !server.Enabled || server.Transport.Kind == "stdio" || server.OAuthState != "ready" {
			continue
		}
		credentialID := server.Transport.HeaderCredentialIDs["Authorization"]
		if credentialID == "" {
			continue
		}
		metadata, err := m.credentials.Metadata(ctx, credentialID)
		if err != nil || metadata.Kind != credentialbroker.KindMCPOAuth || metadata.ExpiresAt == nil {
			continue
		}
		if m.now().Add(oauthRefreshSkew).Before(*metadata.ExpiresAt) {
			continue
		}
		m.refreshSingleflight(ctx, server.ID, credentialID)
	}
}

// refreshSingleflight coalesces concurrent refreshes of the same credential:
// the first caller performs the exchange, the rest wait for its outcome.
func (m *mcpOAuthManager) refreshSingleflight(ctx context.Context, serverID, credentialID string) {
	m.mu.Lock()
	if done, ok := m.flights[credentialID]; ok {
		m.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
		}
		return
	}
	done := make(chan struct{})
	m.flights[credentialID] = done
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.flights, credentialID)
		m.mu.Unlock()
		close(done)
	}()
	m.refreshCredential(ctx, serverID, credentialID)
}

func (m *mcpOAuthManager) refreshCredential(ctx context.Context, serverID, credentialID string) {
	server, err := m.catalog.Get(ctx, serverID)
	if err != nil || server.Transport.HeaderCredentialIDs["Authorization"] != credentialID {
		return
	}
	token, err := m.credentials.ResolveOAuthToken(ctx, credentialID)
	if err != nil {
		return
	}
	defer func() { token.AccessToken, token.RefreshToken = "", "" }()
	if token.RefreshToken == "" || token.TokenEndpoint == "" {
		// Nothing renewable left: invalidate locally and require re-auth.
		m.failOAuthCredential(ctx, server, credentialID)
		return
	}
	refreshed, err := m.exchangeRefreshToken(ctx, token)
	if errors.Is(err, errOAuthGrantInvalid) {
		// The grant is dead (invalid_grant etc.): revoke remotely on a best
		// effort basis, wipe the credential locally, and mark needs_auth.
		m.revokeRemote(ctx, token)
		m.failOAuthCredential(ctx, server, credentialID)
		return
	}
	if err != nil {
		return // transient failure; the next scan retries
	}
	defer func() { refreshed.AccessToken, refreshed.RefreshToken = "", "" }()
	if refreshed.RefreshToken == "" {
		refreshed.RefreshToken = token.RefreshToken
	}
	refreshed.TokenEndpoint, refreshed.RevocationEndpoint = token.TokenEndpoint, token.RevocationEndpoint
	refreshed.ClientID, refreshed.Resource = token.ClientID, token.Resource
	if _, err := m.credentials.PutOAuth(ctx, credentialID, server.Name+" OAuth", refreshed); err != nil {
		return
	}
	if err := m.publisher.Publish(ctx); err != nil {
		log.Printf("mcp oauth: refresh projection failed for server %s: %v", serverID, err)
	}
}

func (m *mcpOAuthManager) exchangeRefreshToken(ctx context.Context, token credentialbroker.OAuthToken) (credentialbroker.OAuthToken, error) {
	endpoint, err := m.validateURL(token.TokenEndpoint, false)
	if err != nil {
		return credentialbroker.OAuthToken{}, err
	}
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token.RefreshToken}}
	if token.ClientID != "" {
		form.Set("client_id", token.ClientID)
	}
	if token.Resource != "" {
		form.Set("resource", token.Resource)
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := m.client.Do(request)
	if err != nil {
		return credentialbroker.OAuthToken{}, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusUnauthorized {
		return credentialbroker.OAuthToken{}, errOAuthGrantInvalid
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return credentialbroker.OAuthToken{}, fmt.Errorf("oauth_refresh_http_status:%d", response.StatusCode)
	}
	var granted struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if decodeLimitedJSON(response.Body, &granted) != nil || granted.AccessToken == "" || !strings.EqualFold(granted.TokenType, "bearer") || granted.ExpiresIn < 0 {
		return credentialbroker.OAuthToken{}, errors.New("invalid_oauth_token_response")
	}
	result := credentialbroker.OAuthToken{AccessToken: granted.AccessToken, RefreshToken: granted.RefreshToken, TokenType: granted.TokenType}
	granted.AccessToken, granted.RefreshToken = "", ""
	if granted.ExpiresIn > 0 {
		value := m.now().Add(time.Duration(granted.ExpiresIn) * time.Second).UTC()
		result.ExpiresAt = &value
	}
	return result, nil
}

// revokeRemote asks the authorization server to revoke the grant's tokens
// (RFC 7009). Best effort: when the server advertises no revocation endpoint
// or the request fails, the caller's local wipe is the authoritative
// revocation and the gap is logged here.
func (m *mcpOAuthManager) revokeRemote(ctx context.Context, token credentialbroker.OAuthToken) {
	if token.RevocationEndpoint == "" {
		log.Printf("mcp oauth: authorization server advertises no revocation endpoint; credential revoked locally only")
		return
	}
	endpoint, err := m.validateURL(token.RevocationEndpoint, false)
	if err != nil {
		log.Printf("mcp oauth: revocation endpoint rejected; credential revoked locally only")
		return
	}
	for _, value := range []string{token.RefreshToken, token.AccessToken} {
		if value == "" {
			continue
		}
		form := url.Values{"token": {value}}
		if token.ClientID != "" {
			form.Set("client_id", token.ClientID)
		}
		request, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), strings.NewReader(form.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response, err := m.client.Do(request)
		if err != nil {
			log.Printf("mcp oauth: remote revocation failed, credential revoked locally only: %v", err)
			continue
		}
		response.Body.Close()
	}
}

func (m *mcpOAuthManager) failOAuthCredential(ctx context.Context, server mcpruntime.Server, credentialID string) {
	if err := m.credentials.Revoke(ctx, credentialID); err != nil && !errors.Is(err, credentialbroker.ErrNotFound) {
		return
	}
	delete(server.Transport.HeaderCredentialIDs, "Authorization")
	server.OAuthState = "needs_auth"
	server.Health = "unknown"
	if _, err := m.catalog.Replace(ctx, server); err != nil {
		return
	}
	// The refresh loop revoked the grant without a user present; record the
	// system-side revocation.
	m.audit.Record(ctx, audit.ActionMCPOAuthRevoke, server.ID, "success", "", map[string]string{"reason": "refresh_failed"})
	if err := m.publisher.Publish(ctx); err != nil {
		log.Printf("mcp oauth: needs_auth projection failed for server %s: %v", server.ID, err)
	}
}

func (m *mcpOAuthManager) discoverProtectedResource(ctx context.Context, resource *url.URL) (protectedResourceMetadata, error) {
	if metadataURL := m.protectedResourceChallenge(ctx, resource); metadataURL != "" {
		candidate, err := m.validateURL(metadataURL, false)
		if err != nil {
			return protectedResourceMetadata{}, errors.New("invalid_oauth_resource_metadata_url")
		}
		var metadata protectedResourceMetadata
		if err := m.getJSON(ctx, candidate.String(), &metadata); err == nil && len(metadata.AuthorizationServers) != 0 {
			if metadata.Resource != "" && metadata.Resource != resource.String() {
				return protectedResourceMetadata{}, errors.New("oauth_resource_metadata_mismatch")
			}
			return metadata, nil
		}
	}
	paths := []string{"/.well-known/oauth-protected-resource" + strings.TrimSuffix(resource.EscapedPath(), "/"), "/.well-known/oauth-protected-resource"}
	for _, path := range paths {
		candidate := *resource
		candidate.Path, candidate.RawPath, candidate.RawQuery, candidate.Fragment = path, "", "", ""
		var metadata protectedResourceMetadata
		if m.getJSON(ctx, candidate.String(), &metadata) == nil && len(metadata.AuthorizationServers) != 0 {
			if metadata.Resource != "" && metadata.Resource != resource.String() {
				return protectedResourceMetadata{}, errors.New("oauth_resource_metadata_mismatch")
			}
			return metadata, nil
		}
	}
	return protectedResourceMetadata{}, errors.New("oauth_protected_resource_discovery_failed")
}

func (m *mcpOAuthManager) protectedResourceChallenge(ctx context.Context, resource *url.URL) string {
	body := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"WorkAgent3","version":"1"}}}`)
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, resource.String(), body)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response, err := m.client.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		return ""
	}
	return quotedAuthParameter(response.Header.Get("WWW-Authenticate"), "resource_metadata")
}

func quotedAuthParameter(header, name string) string {
	needle := strings.ToLower(name) + "="
	lower := strings.ToLower(header)
	start := strings.Index(lower, needle)
	if start < 0 {
		return ""
	}
	value := strings.TrimSpace(header[start+len(needle):])
	if !strings.HasPrefix(value, `"`) {
		if end := strings.IndexAny(value, ", "); end >= 0 {
			value = value[:end]
		}
		return value
	}
	value = value[1:]
	if end := strings.IndexByte(value, '"'); end >= 0 {
		return value[:end]
	}
	return ""
}

func (m *mcpOAuthManager) discoverAuthorizationServer(ctx context.Context, issuer *url.URL) (authorizationServerMetadata, error) {
	paths := []string{"/.well-known/oauth-authorization-server" + strings.TrimSuffix(issuer.EscapedPath(), "/"), strings.TrimSuffix(issuer.EscapedPath(), "/") + "/.well-known/openid-configuration"}
	for _, path := range paths {
		candidate := *issuer
		candidate.Path, candidate.RawPath, candidate.RawQuery, candidate.Fragment = path, "", "", ""
		var metadata authorizationServerMetadata
		if m.getJSON(ctx, candidate.String(), &metadata) == nil && metadata.AuthorizationEndpoint != "" && metadata.TokenEndpoint != "" && strings.TrimSuffix(metadata.Issuer, "/") == strings.TrimSuffix(issuer.String(), "/") {
			return metadata, nil
		}
	}
	return authorizationServerMetadata{}, errors.New("oauth_authorization_server_discovery_failed")
}

func (m *mcpOAuthManager) registerClient(ctx context.Context, endpoint *url.URL, redirectURI string) (string, error) {
	body, _ := json.Marshal(map[string]any{"client_name": "WorkAgent3", "redirect_uris": []string{redirectURI}, "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "token_endpoint_auth_method": "none"})
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response, err := m.client.Do(request)
	if err != nil {
		return "", errors.New("oauth_client_registration_failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("oauth_registration_http_status:%d", response.StatusCode)
	}
	var registration struct {
		ClientID string `json:"client_id"`
	}
	if decodeLimitedJSON(response.Body, &registration) != nil || registration.ClientID == "" {
		return "", errors.New("invalid_oauth_registration_response")
	}
	return registration.ClientID, nil
}

func (m *mcpOAuthManager) getJSON(ctx context.Context, endpoint string, value any) error {
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	request.Header.Set("Accept", "application/json")
	response, err := m.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("metadata_not_found")
	}
	return decodeLimitedJSON(response.Body, value)
}

func decodeLimitedJSON(reader io.Reader, value any) error {
	data, err := io.ReadAll(io.LimitReader(reader, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return errors.New("JSON response too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return errors.New("invalid trailing JSON")
	}
	return nil
}

func (m *mcpOAuthManager) validateURL(raw string, redirect bool) (*url.URL, error) {
	value, err := url.Parse(raw)
	if err != nil || value.Host == "" || value.User != nil || value.Fragment != "" {
		return nil, errors.New("invalid URL")
	}
	if value.Scheme == "https" {
		return value, nil
	}
	if (redirect || m.allowPrivate) && value.Scheme == "http" && isLoopbackHost(value.Hostname()) {
		return value, nil
	}
	return nil, errors.New("HTTPS required")
}

func isLoopbackHost(host string) bool {
	return strings.EqualFold(host, "localhost") || strings.HasPrefix(host, "127.") || host == "::1"
}

func (m *mcpOAuthManager) purgeLocked() {
	now := m.now()
	for id, flow := range m.pending {
		if !now.Before(flow.expiresAt) {
			clearBytes(flow.verifier)
			delete(m.pending, id)
		}
	}
}

func oauthRandomBytes(size int) ([]byte, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return nil, err
	}
	encoded := make([]byte, base64.RawURLEncoding.EncodedLen(len(value)))
	base64.RawURLEncoding.Encode(encoded, value)
	clearBytes(value)
	return encoded, nil
}
