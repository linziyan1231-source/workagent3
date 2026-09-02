package userhost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
)

type oauthTestClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *oauthTestClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *oauthTestClock) Advance(delta time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(delta)
}

type recordingPublisher struct {
	mu    sync.Mutex
	count int
}

func (p *recordingPublisher) Publish(context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.count++
	return nil
}

func (p *recordingPublisher) Count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.count
}

// mockOAuthAuthorizationServer simulates the token/refresh/revoke endpoints of
// a local OAuth authorization server for the W13 refresh tests.
type mockOAuthAuthorizationServer struct {
	*httptest.Server
	mu             sync.Mutex
	refreshGrants  []string // refresh_token values presented to /token
	revokedTokens  []string // token values presented to /revoke
	refreshCalls   int
	accessCounter  int
	failRefresh    bool
	refreshStarted chan struct{}
	refreshRelease chan struct{}
}

func newMockOAuthAuthorizationServer(t *testing.T, resource *string) *mockOAuthAuthorizationServer {
	t.Helper()
	mock := &mockOAuthAuthorizationServer{}
	mock.Server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/.well-known/oauth-protected-resource/mcp":
			writeRuntimeJSON(writer, http.StatusOK, map[string]any{
				"resource": *resource, "authorization_servers": []string{mock.URL}, "scopes_supported": []string{"tools:read"},
			})
		case "/.well-known/oauth-authorization-server":
			writeRuntimeJSON(writer, http.StatusOK, map[string]any{
				"issuer": mock.URL, "authorization_endpoint": mock.URL + "/authorize", "token_endpoint": mock.URL + "/token",
				"registration_endpoint": mock.URL + "/register", "revocation_endpoint": mock.URL + "/revoke",
			})
		case "/register":
			writeRuntimeJSON(writer, http.StatusCreated, map[string]string{"client_id": "dynamic-client"})
		case "/token":
			_ = request.ParseForm()
			mock.mu.Lock()
			mock.accessCounter++
			accessToken := "access-" + string(rune('0'+mock.accessCounter))
			switch request.Form.Get("grant_type") {
			case "authorization_code":
				mock.mu.Unlock()
				writeRuntimeJSON(writer, http.StatusOK, map[string]any{
					"access_token": accessToken, "refresh_token": "refresh-" + accessToken, "token_type": "Bearer", "expires_in": 120,
				})
			case "refresh_token":
				mock.refreshCalls++
				mock.refreshGrants = append(mock.refreshGrants, request.Form.Get("refresh_token"))
				failed, started, release := mock.failRefresh, mock.refreshStarted, mock.refreshRelease
				mock.mu.Unlock()
				if failed {
					writeRuntimeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
					return
				}
				if started != nil {
					close(started)
					<-release
				}
				if request.Form.Get("client_id") != "dynamic-client" || request.Form.Get("resource") != *resource {
					t.Errorf("incomplete refresh request: %#v", request.Form)
				}
				writeRuntimeJSON(writer, http.StatusOK, map[string]any{
					"access_token": "refreshed-" + accessToken, "refresh_token": "refresh-rotated-" + accessToken, "token_type": "Bearer", "expires_in": 3600,
				})
			default:
				writer.WriteHeader(http.StatusBadRequest)
			}
		case "/revoke":
			_ = request.ParseForm()
			mock.mu.Lock()
			mock.revokedTokens = append(mock.revokedTokens, request.Form.Get("token"))
			mock.mu.Unlock()
			writer.WriteHeader(http.StatusOK)
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(mock.Server.Close)
	*resource = mock.URL + "/mcp"
	return mock
}

func (m *mockOAuthAuthorizationServer) stats() (grants, revoked []string, refreshCalls int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.refreshGrants...), append([]string(nil), m.revokedTokens...), m.refreshCalls
}

// completeOAuthFlow runs start+complete against the mock server and returns
// the credential ID now mapped to the server.
func completeOAuthFlow(t *testing.T, manager *mcpOAuthManager, catalog *mcpruntime.Catalog, serverID string) string {
	t.Helper()
	start, err := manager.start(context.Background(), serverID, "http://127.0.0.1:7777/oauth/mcp/callback")
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.complete(context.Background(), serverID, start.FlowID, start.State, "authorization-code"); err != nil {
		t.Fatal(err)
	}
	server, err := catalog.Get(context.Background(), serverID)
	if err != nil {
		t.Fatal(err)
	}
	credentialID := server.Transport.HeaderCredentialIDs["Authorization"]
	if credentialID == "" || server.OAuthState != "ready" {
		t.Fatalf("OAuth flow did not reach ready state: %#v", server)
	}
	return credentialID
}

func newOAuthTestServer(t *testing.T, catalog *mcpruntime.Catalog, resource string) mcpruntime.Server {
	t.Helper()
	server, err := catalog.Create(context.Background(), mcpruntime.Server{
		ID: "remote", Name: "Remote", Source: "user", Enabled: true,
		Transport:  mcpruntime.Transport{Kind: "http", URL: resource, HeaderCredentialIDs: map[string]string{}},
		ToolPolicy: "all", AllowedTools: []string{}, OAuthState: "needs_auth", Health: "unknown",
	})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func TestMCPOAuthRefreshRestoresExpiredToken(t *testing.T) {
	var resource string
	mock := newMockOAuthAuthorizationServer(t, &resource)
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	server := newOAuthTestServer(t, catalog, resource)
	credentials := openGatewayCredentials(t)
	publisher := &recordingPublisher{}
	clock := &oauthTestClock{now: time.Now()}
	manager := newMCPOAuthManager(catalog, credentials, publisher)
	manager.client = mock.Client()
	manager.allowPrivate = true
	manager.now = clock.Now

	credentialID := completeOAuthFlow(t, manager, catalog, server.ID)
	publishedBefore := publisher.Count()

	// The access token (expires_in=120) is now past expiry; the scan must
	// refresh it without any user interaction.
	clock.Advance(3 * time.Minute)
	manager.refreshDue(context.Background())

	grants, _, refreshCalls := mock.stats()
	if refreshCalls != 1 || len(grants) != 1 || grants[0] != "refresh-access-1" {
		t.Fatalf("refresh grant not used exactly once: grants=%v calls=%d", grants, refreshCalls)
	}
	projected, err := credentials.ResolveMCPValue(context.Background(), credentialID)
	if err != nil || string(projected) != "Bearer refreshed-access-2" {
		t.Fatalf("projection did not recover seamlessly: %q, %v", projected, err)
	}
	clearBytes(projected)
	// The rotated refresh token must be stored for the next cycle.
	stored, err := credentials.ResolveOAuthToken(context.Background(), credentialID)
	if err != nil || stored.RefreshToken != "refresh-rotated-access-2" || stored.TokenEndpoint == "" || stored.ClientID != "dynamic-client" {
		t.Fatalf("rotated grant metadata not persisted: %#v, %v", stored, err)
	}
	server, err = catalog.Get(context.Background(), server.ID)
	if err != nil || server.OAuthState != "ready" {
		t.Fatalf("server left ready state: %#v, %v", server, err)
	}
	if publisher.Count() != publishedBefore+1 {
		t.Fatalf("refresh did not re-project exactly once: %d -> %d", publishedBefore, publisher.Count())
	}
}

func TestMCPOAuthRefreshFailureMarksNeedsAuthAndRevokes(t *testing.T) {
	var resource string
	mock := newMockOAuthAuthorizationServer(t, &resource)
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	server := newOAuthTestServer(t, catalog, resource)
	credentials := openGatewayCredentials(t)
	publisher := &recordingPublisher{}
	clock := &oauthTestClock{now: time.Now()}
	manager := newMCPOAuthManager(catalog, credentials, publisher)
	manager.client = mock.Client()
	manager.allowPrivate = true
	manager.now = clock.Now

	credentialID := completeOAuthFlow(t, manager, catalog, server.ID)

	mock.mu.Lock()
	mock.failRefresh = true
	mock.mu.Unlock()
	clock.Advance(3 * time.Minute)
	manager.refreshDue(context.Background())

	updated, err := catalog.Get(context.Background(), server.ID)
	if err != nil || updated.OAuthState != "needs_auth" || updated.Transport.HeaderCredentialIDs["Authorization"] != "" {
		t.Fatalf("failed refresh did not mark needs_auth: %#v, %v", updated, err)
	}
	metadata, err := credentials.Metadata(context.Background(), credentialID)
	if err != nil || metadata.State != credentialbroker.StateRevoked {
		t.Fatalf("dead grant not revoked locally: %#v, %v", metadata, err)
	}
	if _, err := credentials.ResolveOAuthToken(context.Background(), credentialID); err == nil {
		t.Fatal("revoked credential still resolves")
	}
	_, revoked, _ := mock.stats()
	found := false
	for _, token := range revoked {
		if token == "refresh-access-1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("authorization server never asked to revoke the dead grant: %v", revoked)
	}
}

func TestMCPOAuthRefreshSingleflight(t *testing.T) {
	var resource string
	mock := newMockOAuthAuthorizationServer(t, &resource)
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	server := newOAuthTestServer(t, catalog, resource)
	credentials := openGatewayCredentials(t)
	manager := newMCPOAuthManager(catalog, credentials, gatewayTestPublisher{})
	manager.client = mock.Client()
	manager.allowPrivate = true

	credentialID := completeOAuthFlow(t, manager, catalog, server.ID)

	mock.mu.Lock()
	mock.refreshStarted = make(chan struct{})
	mock.refreshRelease = make(chan struct{})
	mock.mu.Unlock()

	const callers = 8
	var waiters sync.WaitGroup
	waiters.Add(callers)
	for range callers {
		go func() {
			defer waiters.Done()
			manager.refreshSingleflight(context.Background(), server.ID, credentialID)
		}()
	}
	<-mock.refreshStarted
	// Give the remaining callers a chance to pile onto the in-flight refresh.
	time.Sleep(50 * time.Millisecond)
	close(mock.refreshRelease)
	waiters.Wait()

	_, _, refreshCalls := mock.stats()
	if refreshCalls != 1 {
		t.Fatalf("singleflight broken: %d refresh exchanges for one credential", refreshCalls)
	}
}

func TestMCPOAuthRefreshCrossSIDIsolation(t *testing.T) {
	var resource string
	mock := newMockOAuthAuthorizationServer(t, &resource)
	// SID A runs the full OAuth flow; SID B owns an independent catalog and
	// credential broker that must stay untouched.
	catalogA, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalogA.Close()
	serverA := newOAuthTestServer(t, catalogA, resource)
	credentialsA := openGatewayCredentials(t)
	clock := &oauthTestClock{now: time.Now()}
	managerA := newMCPOAuthManager(catalogA, credentialsA, gatewayTestPublisher{})
	managerA.client = mock.Client()
	managerA.allowPrivate = true
	managerA.now = clock.Now
	credentialA := completeOAuthFlow(t, managerA, catalogA, serverA.ID)

	catalogB, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalogB.Close()
	serverB := newOAuthTestServer(t, catalogB, resource)
	credentialsB := openGatewayCredentials(t)
	if _, err := credentialsB.PutOAuth(context.Background(), "sid-b-credential", "Remote OAuth", credentialbroker.OAuthToken{
		AccessToken: "sid-b-access", RefreshToken: "sid-b-refresh", TokenType: "Bearer",
	}); err != nil {
		t.Fatal(err)
	}
	serverB.Transport.HeaderCredentialIDs = map[string]string{"Authorization": "sid-b-credential"}
	serverB.OAuthState = "ready"
	if _, err := catalogB.Replace(context.Background(), serverB); err != nil {
		t.Fatal(err)
	}

	clock.Advance(3 * time.Minute)
	managerA.refreshDue(context.Background())

	// SID B's broker never heard of SID A's credential and its own grant is
	// byte-identical to before the refresh.
	if _, err := credentialsB.Metadata(context.Background(), credentialA); err == nil {
		t.Fatal("SID A credential leaked into SID B broker")
	}
	projectedB, err := credentialsB.ResolveMCPValue(context.Background(), "sid-b-credential")
	if err != nil || string(projectedB) != "Bearer sid-b-access" {
		t.Fatalf("SID B credential modified by SID A refresh: %q, %v", projectedB, err)
	}
	clearBytes(projectedB)
	untouchedB, err := catalogB.Get(context.Background(), serverB.ID)
	if err != nil || untouchedB.OAuthState != "ready" || untouchedB.Transport.HeaderCredentialIDs["Authorization"] != "sid-b-credential" {
		t.Fatalf("SID B catalog modified by SID A refresh: %#v, %v", untouchedB, err)
	}
}

func TestMCPOAuthReauthorizationRevokesReplacedCredential(t *testing.T) {
	var resource string
	mock := newMockOAuthAuthorizationServer(t, &resource)
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	server := newOAuthTestServer(t, catalog, resource)
	credentials := openGatewayCredentials(t)
	manager := newMCPOAuthManager(catalog, credentials, gatewayTestPublisher{})
	manager.client = mock.Client()
	manager.allowPrivate = true

	oldCredentialID := completeOAuthFlow(t, manager, catalog, server.ID)
	newCredentialID := completeOAuthFlow(t, manager, catalog, server.ID)
	if oldCredentialID == newCredentialID {
		t.Fatal("re-authorization reused the credential ID")
	}

	metadata, err := credentials.Metadata(context.Background(), oldCredentialID)
	if err != nil || metadata.State != credentialbroker.StateRevoked {
		t.Fatalf("replaced credential not revoked: %#v, %v", metadata, err)
	}
	_, revoked, _ := mock.stats()
	found := false
	for _, token := range revoked {
		if token == "refresh-access-1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("replaced grant never revoked at the authorization server: %v", revoked)
	}
	projected, err := credentials.ResolveMCPValue(context.Background(), newCredentialID)
	if err != nil || string(projected) != "Bearer access-2" {
		t.Fatalf("new grant not projected: %q, %v", projected, err)
	}
	clearBytes(projected)
}
