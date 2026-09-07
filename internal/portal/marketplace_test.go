package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"workagent3/internal/marketplace"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestMarketplaceSnapshotsDependenciesAndResumesRecipientInstall(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	market, _ := marketplace.Open(":memory:")
	defer market.Close()
	alice, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-4001", "unused")
	bob, _ := data.CreateUser(t.Context(), "bob", "S-1-5-21-4002", "unused")
	for _, u := range []store.User{alice, bob} {
		_ = data.CreateSession(t.Context(), u.Username, u.ID, time.Now().Add(time.Hour))
	}
	createdMCP := []map[string]any{}
	createdSkills := []map[string]any{}
	createdPresets := []map[string]any{}
	credentialCount := 0
	failSkill := true
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/skills":
			write([]map[string]any{{"id": "skill-source", "name": "writing", "description": "Writing", "version": "1.0.0", "source": "user", "requiredMcpServerIds": []string{"mcp-source"}}})
		case "GET /v1/mcp-servers":
			write([]map[string]any{{"id": "mcp-source", "name": "Docs", "source": "user", "enabled": true, "transport": map[string]any{"kind": "http", "url": "https://example.com/mcp", "headerCredentialIds": map[string]string{"Authorization": "publisher-private-reference"}}, "toolPolicy": "all", "allowedTools": []string{}, "oauthState": "none"}})
		case "GET /v1/presets":
			write([]map[string]any{{"id": "assistant-source", "source": "user", "name": "Writer", "engine": "harness", "description": "Writer", "systemPrompt": "Write using the skill", "workspacePolicy": "optional", "skillIds": []string{"skill-source"}, "mcpServerIds": []string{}, "toolAllowlist": []string{}, "approvalPolicy": "on_risk"}})
		case "GET /v1/skills/export":
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write([]byte("immutable-skill-archive"))
		case "POST /v1/credentials":
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input["secret"] != "recipient-secret" {
				t.Error("recipient credential was not used")
			}
			credentialCount++
			write(map[string]string{"id": "recipient-credential"})
		case "POST /v1/mcp-servers":
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			input["id"] = "recipient-mcp"
			createdMCP = append(createdMCP, input)
			write(input)
		case "POST /v1/skills/market-install":
			if failSkill {
				failSkill = false
				w.WriteHeader(503)
				return
			}
			v := map[string]any{"id": "recipient-skill", "name": "writing"}
			createdSkills = append(createdSkills, v)
			write(v)
		case "POST /v1/presets":
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			input["id"] = "recipient-assistant"
			createdPresets = append(createdPresets, input)
			write(input)
		case "PATCH /v1/presets/recipient-assistant":
			write(map[string]bool{"enabled": true})
		default:
			w.WriteHeader(404)
		}
	}))
	defer runtime.Close()
	base, _ := url.Parse(runtime.URL)
	server, _ := NewWithModules(data, StaticRouter{alice.SID: runtimeapi.Endpoint{BaseURL: base, Token: "test-runtime"}, bob.SID: runtimeapi.Endpoint{BaseURL: base, Token: "test-runtime"}}, false, Modules{Marketplace: market})
	call := func(actor, method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://portal.test"+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: actor})
		r.Header.Set("Origin", "http://portal.test")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		return w
	}
	published := call("alice", "POST", "/api/portal/marketplace", `{"kind":"assistant","sourceId":"assistant-source","name":"Shared writer","description":"A writer","version":"1.0.0"}`)
	if published.Code != 201 {
		t.Fatalf("publish: %d %s", published.Code, published.Body.String())
	}
	var result struct {
		Entry marketplace.Entry `json:"entry"`
	}
	_ = json.Unmarshal(published.Body.Bytes(), &result)
	id := result.Entry.ID
	_, bundle, err := market.Get(t.Context(), id)
	if err != nil || len(bundle.Skills) != 1 || len(bundle.MCP) != 1 {
		t.Fatalf("missing transitive dependency: %v %+v", err, bundle)
	}
	encoded, _ := json.Marshal(bundle)
	if strings.Contains(string(encoded), "publisher-private-reference") {
		t.Fatal("publisher credential reference escaped into bundle")
	}
	if string(bundle.Skills[0].Archive) != "immutable-skill-archive" {
		t.Fatal("skill snapshot missing")
	}
	detail := call("bob", "GET", "/api/portal/marketplace?id="+id, "")
	if strings.Contains(detail.Body.String(), "archive") {
		t.Fatal("browser detail exposed archive")
	}
	denied := call("bob", "DELETE", "/api/portal/marketplace?id="+id, "")
	if denied.Code != 403 {
		t.Fatal("other member could unpublish")
	}
	payload := `{"id":"` + id + `","credentials":{"mcp-source":{"Authorization":"recipient-secret"}}}`
	first := call("bob", "POST", "/api/portal/marketplace/install", payload)
	if first.Code < 400 {
		t.Fatal("partial install advertised success")
	}
	// Mimic persisted runtime resources on retry: the checkpoint maps them by id.
	oldHandler := runtime.Config.Handler
	runtime.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/v1/mcp-servers" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(createdMCP)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/v1/skills" && len(createdSkills) > 0 {
			_ = json.NewEncoder(w).Encode(createdSkills)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/v1/presets" && len(createdPresets) > 0 {
			_ = json.NewEncoder(w).Encode(createdPresets)
			return
		}
		oldHandler.ServeHTTP(w, r)
	})
	second := call("bob", "POST", "/api/portal/marketplace/install", payload)
	if second.Code != 201 {
		t.Fatalf("retry: %d %s", second.Code, second.Body.String())
	}
	third := call("bob", "POST", "/api/portal/marketplace/install", `{"id":"`+id+`"}`)
	if third.Code != 201 || len(createdMCP) != 1 || len(createdSkills) != 1 || len(createdPresets) != 1 || credentialCount != 1 {
		t.Fatal("repeat install duplicated resources")
	}
	preset := createdPresets[0]
	if preset["skillIds"].([]any)[0] != "recipient-skill" || preset["mcpServerIds"].([]any)[0] != "recipient-mcp" {
		t.Fatal("assistant dependency ids were not remapped")
	}
	installed, _ := market.Installation(t.Context(), bob.SID, id)
	if !installed.Complete {
		t.Fatal("complete installation missing")
	}
	if list := call("bob", "GET", "/api/portal/marketplace", ""); !strings.Contains(list.Body.String(), `"installed":true`) {
		t.Fatal("recipient install status missing")
	}
	if removed := call("alice", "DELETE", "/api/portal/marketplace?id="+id, ""); removed.Code != 204 {
		t.Fatal("owner cannot unpublish")
	}
	if skill, err := market.InstalledSkill(t.Context(), bob.SID, "recipient-skill"); err != nil || len(skill.RequiredMCP) != 1 || skill.RequiredMCP[0] != "recipient-mcp" {
		t.Fatal("unpublish invalidated installed snapshot")
	}
}
func TestPortableConnectorDoesNotPublishVaultReferencesOrCredentialURLs(t *testing.T) {
	for _, address := range []string{"https://user:password@example.com/mcp", "https://example.com/mcp?api_key=secret"} {
		_, err := portableConnector(mcpruntime.Server{Transport: mcpruntime.Transport{Kind: "http", URL: address}})
		if err == nil {
			t.Fatal("credential URL allowed")
		}
	}
	connector, err := portableConnector(mcpruntime.Server{Source: "managed", ID: "builtin", Name: "Managed", Transport: mcpruntime.Transport{Command: `C:\private\server.exe`}})
	if err != nil || !connector.Builtin || connector.Transport.Command != "" {
		t.Fatal("managed dependency must remain a portable reference")
	}
}
