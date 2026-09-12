package portal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/marketplace"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

type fakeProfessionalDatabase struct {
	statusSIDs     []string
	connectionSIDs []string
	disabled       bool
}

func (p *fakeProfessionalDatabase) ProfessionalDatabaseStatus(_ context.Context, sid string) (contracts.ProfessionalDatabaseStatus, error) {
	p.statusSIDs = append(p.statusSIDs, sid)
	return contracts.ProfessionalDatabaseStatus{Configured: true, Timezone: "Asia/Shanghai", DailyRemaining: 7, MonthlyRemaining: 87,
		KimiDatasourceGrant: contracts.KimiDatasourceGrant{Enabled: !p.disabled, AllowedSources: []string{"arxiv"}, DailyLimit: 10, MonthlyLimit: 100, DailyUsed: 3, MonthlyUsed: 13}}, nil
}
func (p *fakeProfessionalDatabase) ProfessionalDatabaseConnection(_ context.Context, sid string) (contracts.ProfessionalDatabaseConnection, error) {
	p.connectionSIDs = append(p.connectionSIDs, sid)
	if p.disabled {
		return contracts.ProfessionalDatabaseConnection{}, errors.New("professional_database_disabled")
	}
	return contracts.ProfessionalDatabaseConnection{Endpoint: "http://127.0.0.1:18301/professional-database/mcp", Token: "private-employee-" + sid}, nil
}

func TestProfessionalDatabaseMarketSeparatesPublicationFromRecipientCredentials(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	market, err := marketplace.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer market.Close()
	admin, _ := data.CreateUser(t.Context(), "manager", "S-1-5-21-9000", "unused")
	bob, _ := data.CreateUser(t.Context(), "bob", "S-1-5-21-9001", "unused")
	_ = data.SetUserAdmin(t.Context(), admin.Username, true)
	for _, user := range []store.User{admin, bob} {
		_ = data.CreateSession(t.Context(), user.Username, user.ID, time.Now().Add(time.Hour))
	}
	port := &fakeProfessionalDatabase{}
	var servers []map[string]any
	credentialCount := 0
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/skills", "GET /v1/presets":
			_ = json.NewEncoder(w).Encode([]any{})
		case "GET /v1/mcp-servers":
			_ = json.NewEncoder(w).Encode(servers)
		case "POST /v1/credentials":
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input["secret"] != "Bearer private-employee-"+bob.SID {
				t.Error("installation did not use recipient's protected token")
			}
			credentialCount++
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "recipient-vault-id"})
		case "POST /v1/mcp-servers":
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			input["id"] = "recipient-mcp-id"
			servers = append(servers, input)
			_ = json.NewEncoder(w).Encode(input)
		default:
			w.WriteHeader(404)
		}
	}))
	defer runtime.Close()
	base, _ := url.Parse(runtime.URL)
	server, err := NewWithModules(data, StaticRouter{bob.SID: runtimeapi.Endpoint{BaseURL: base, Token: "runtime-token"}}, false,
		Modules{Marketplace: market, EmployeeManagement: &fakeEmployeeManagement{}, ProfessionalDatabase: port})
	if err != nil {
		t.Fatal(err)
	}
	call := func(actor, method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://portal.test"+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: actor})
		r.Header.Set("Origin", "http://portal.test")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		return w
	}
	if denied := call("bob", "POST", "/api/portal/admin/marketplace/professional-database", ""); denied.Code != 403 {
		t.Fatalf("nonadmin publish status %d", denied.Code)
	}
	for _, want := range []int{201, 200} {
		w := call("manager", "POST", "/api/portal/admin/marketplace/professional-database", "")
		if w.Code != want {
			t.Fatalf("publish status %d: %s", w.Code, w.Body.String())
		}
	}
	_, bundle, err := market.Get(t.Context(), professionalDatabaseMarketID)
	if err != nil || !containsProfessionalDatabase(bundle) {
		t.Fatalf("missing service bundle: %v", err)
	}
	encoded, _ := json.Marshal(bundle)
	if strings.Contains(string(encoded), "127.0.0.1") || strings.Contains(string(encoded), "private-employee") || len(bundle.MCP[0].CredentialNames) != 0 {
		t.Fatal("public market bundle exposed private configuration")
	}
	detail := call("bob", "GET", "/api/portal/marketplace?id="+professionalDatabaseMarketID+"&sid="+admin.SID, "")
	if detail.Code != 200 || !strings.Contains(detail.Body.String(), `"daily_remaining":7`) || !strings.Contains(detail.Body.String(), `"monthly_limit":100`) {
		t.Fatalf("quota detail: %d %s", detail.Code, detail.Body.String())
	}
	if port.statusSIDs[len(port.statusSIDs)-1] != bob.SID {
		t.Fatal("detail accepted another user's SID")
	}
	if strings.Contains(detail.Body.String(), "private-employee") {
		t.Fatal("detail leaked an employee token")
	}
	payload := `{"id":"` + professionalDatabaseMarketID + `","credentials":{"professional-database":{"Authorization":"untrusted-input"}}}`
	for i := 0; i < 2; i++ {
		w := call("bob", "POST", "/api/portal/marketplace/install", payload)
		if w.Code != 201 {
			t.Fatalf("install: %d %s", w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "private-employee") || strings.Contains(w.Body.String(), "recipient-vault-id") {
			t.Fatal("browser response leaked installation credentials")
		}
	}
	if len(servers) != 1 || credentialCount != 1 {
		t.Fatal("repeat install duplicated credentials or MCP")
	}
	for _, sid := range port.connectionSIDs {
		if sid != bob.SID {
			t.Fatal("installed using publisher's identity")
		}
	}
	transport := servers[0]["transport"].(map[string]any)
	if transport["headerCredentialIds"].(map[string]any)["Authorization"] != "recipient-vault-id" {
		t.Fatal("MCP transport missing credential reference")
	}
	port.disabled = true
	if w := call("bob", "POST", "/api/portal/marketplace/install", payload); w.Code < 400 || !strings.Contains(w.Body.String(), "professional_database_disabled") {
		t.Fatalf("revoked user installation accepted: %s", w.Body.String())
	}
	if _, err := server.professionalDatabaseDetail(t.Context(), bob.SID, marketplace.Bundle{}); err != nil {
		t.Fatal(err)
	}
	if v, _ := server.professionalDatabaseDetail(t.Context(), bob.SID, marketplace.Bundle{}); v != nil {
		t.Fatal("ordinary MCP received database quotas")
	}
}

func TestProfessionalDatabaseInstallRevokesCredentialWhenConnectorCreationFails(t *testing.T) {
	revoked := false
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/credentials":
			writeJSON(w, 201, map[string]string{"id": "orphan-id"})
		case "POST /v1/mcp-servers":
			w.WriteHeader(503)
		case "DELETE /v1/credentials/orphan-id":
			revoked = true
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	defer runtime.Close()
	base, _ := url.Parse(runtime.URL)
	s := &Server{modules: Modules{ProfessionalDatabase: &fakeProfessionalDatabase{}}}
	_, err := s.installProfessionalDatabase(t.Context(), marketRuntime{endpoint: runtimeapi.Endpoint{BaseURL: base}}, store.User{SID: "S-1-5-21-42"}, marketplace.Entry{ID: professionalDatabaseMarketID}, marketplace.Connector{ManagedService: professionalDatabaseService}, "")
	if err == nil || !revoked {
		t.Fatal("failed installation left a usable orphan credential")
	}
}

func TestRepublishingProfessionalDatabasePreservesRecipientBinding(t *testing.T) {
	connector, err := portableConnector(mcpruntime.Server{ID: "installed-id", Name: "专业数据库", Source: "user", Transport: mcpruntime.Transport{
		Kind: "http", ManagedService: professionalDatabaseService, URL: "http://127.0.0.1:18301/professional-database/mcp", HeaderCredentialIDs: map[string]string{"Authorization": "publisher-vault"}}})
	if err != nil || connector.ManagedService != professionalDatabaseService || connector.Transport.URL != "" || len(connector.CredentialNames) != 0 {
		t.Fatalf("republished database lost account binding: %+v %v", connector, err)
	}
}
