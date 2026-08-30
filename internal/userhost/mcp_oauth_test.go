package userhost

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
)

func TestMCPOAuthDiscoversRegistersAndStoresTokens(t *testing.T) {
	var serverURL string
	var tokenResource string
	oauthServer := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/.well-known/oauth-protected-resource/mcp":
			writeRuntimeJSON(writer, http.StatusOK, map[string]any{
				"resource": serverURL + "/mcp", "authorization_servers": []string{serverURL}, "scopes_supported": []string{"tools:read"},
			})
		case "/.well-known/oauth-authorization-server":
			writeRuntimeJSON(writer, http.StatusOK, map[string]any{
				"issuer": serverURL, "authorization_endpoint": serverURL + "/authorize", "token_endpoint": serverURL + "/token", "registration_endpoint": serverURL + "/register",
			})
		case "/register":
			var input map[string]any
			_ = json.NewDecoder(request.Body).Decode(&input)
			if input["token_endpoint_auth_method"] != "none" {
				t.Errorf("unexpected registration: %#v", input)
			}
			writeRuntimeJSON(writer, http.StatusCreated, map[string]string{"client_id": "dynamic-client"})
		case "/token":
			_ = request.ParseForm()
			tokenResource = request.Form.Get("resource")
			if request.Form.Get("code_verifier") == "" || request.Form.Get("client_id") != "dynamic-client" {
				t.Errorf("incomplete token request: %#v", request.Form)
			}
			writeRuntimeJSON(writer, http.StatusOK, map[string]any{
				"access_token": "access-private", "refresh_token": "refresh-private", "token_type": "Bearer", "expires_in": 3600,
			})
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer oauthServer.Close()
	serverURL = oauthServer.URL
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	server, err := catalog.Create(context.Background(), mcpruntime.Server{
		ID: "remote", Name: "Remote", Source: "user", Enabled: true,
		Transport:  mcpruntime.Transport{Kind: "http", URL: serverURL + "/mcp", HeaderCredentialIDs: map[string]string{}},
		ToolPolicy: "all", AllowedTools: []string{}, OAuthState: "needs_auth", Health: "unknown",
	})
	if err != nil {
		t.Fatal(err)
	}
	credentials := openGatewayCredentials(t)
	manager := newMCPOAuthManager(catalog, credentials, gatewayTestPublisher{})
	manager.client = oauthServer.Client()
	manager.allowPrivate = true
	start, err := manager.start(context.Background(), server.ID, "http://127.0.0.1:7777/oauth/mcp/callback")
	if err != nil {
		t.Fatal(err)
	}
	authorizationURL, err := url.Parse(start.AuthorizationURL)
	if err != nil || authorizationURL.Query().Get("resource") != serverURL+"/mcp" || authorizationURL.Query().Get("code_challenge_method") != "S256" || authorizationURL.Query().Get("scope") != "tools:read" {
		t.Fatalf("unexpected authorization URL: %s, %v", start.AuthorizationURL, err)
	}
	if err := manager.complete(context.Background(), server.ID, start.FlowID, start.State, "authorization-code"); err != nil {
		t.Fatal(err)
	}
	if tokenResource != serverURL+"/mcp" {
		t.Fatalf("token resource = %q", tokenResource)
	}
	updated, err := catalog.Get(context.Background(), server.ID)
	if err != nil || updated.OAuthState != "ready" || updated.Health != "unknown" {
		t.Fatalf("OAuth state not persisted: %#v, %v", updated, err)
	}
	credentialID := updated.Transport.HeaderCredentialIDs["Authorization"]
	metadata, err := credentials.Metadata(context.Background(), credentialID)
	if err != nil || metadata.Kind != credentialbroker.KindMCPOAuth {
		t.Fatalf("OAuth credential missing: %#v, %v", metadata, err)
	}
	projected, err := credentials.ResolveMCPValue(context.Background(), credentialID)
	if err != nil || string(projected) != "Bearer access-private" || strings.Contains(string(projected), "refresh-private") {
		t.Fatalf("unexpected projected token %q: %v", projected, err)
	}
	clearBytes(projected)
	if err := manager.logout(context.Background(), server.ID); err != nil {
		t.Fatal(err)
	}
	loggedOut, _ := catalog.Get(context.Background(), server.ID)
	if loggedOut.OAuthState != "needs_auth" || loggedOut.Transport.HeaderCredentialIDs["Authorization"] != "" {
		t.Fatalf("logout did not detach token: %#v", loggedOut)
	}
}

func TestMCPOAuthRejectsUntrustedRedirect(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "http://runtime/v1/mcp-servers/id/oauth/start", nil)
	request.Host = "workagent.example"
	request.Header.Set("X-Forwarded-Proto", "https")
	if redirectMatchesRequest("https://attacker.example/oauth/mcp/callback", request) {
		t.Fatal("cross-origin OAuth redirect was accepted")
	}
	if !redirectMatchesRequest("https://workagent.example/oauth/mcp/callback", request) {
		t.Fatal("same-origin OAuth redirect was rejected")
	}
}
