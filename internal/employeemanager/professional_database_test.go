package employeemanager

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"workagent3/internal/contracts"
	"workagent3/internal/professionaldb"
	"workagent3/internal/store"
)

type professionalTestProtector struct{}

func (professionalTestProtector) Seal(value []byte) ([]byte, error) {
	result := append([]byte("test-protected:"), value...)
	for index := len("test-protected:"); index < len(result); index++ {
		result[index] ^= 0xa5
	}
	return result, nil
}
func (professionalTestProtector) Open(value []byte) ([]byte, error) {
	if !strings.HasPrefix(string(value), "test-protected:") {
		return nil, errors.New("invalid test ciphertext")
	}
	result := append([]byte(nil), value[len("test-protected:"):]...)
	for index := range result {
		result[index] ^= 0xa5
	}
	return result, nil
}

func professionalServiceFixture(t *testing.T) (*Service, *atomic.Int64) {
	t.Helper()
	base := t.TempDir()
	data, err := professionaldb.Open(filepath.Join(base, "professional.db"), professionalTestProtector{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	service := &Service{ProfessionalDatabase: data, ProfessionalDatabaseURL: "http://127.0.0.1:1/professional-database/mcp", Users: listStore{users: []store.User{
		{Username: "alice", SID: "S-1-5-21-1000"}, {Username: "bob", SID: "S-1-5-21-1001"},
	}}}
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer upstream-test-access" {
			t.Error("upstream authorization missing")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"is_success":true,"result":{"assistant":[{"type":"text","text":"query result"}]}}`))
	}))
	t.Cleanup(upstream.Close)
	credentials := filepath.Join(base, "credential.json")
	if err := os.WriteFile(credentials, []byte(`{"access_token":"upstream-test-access"}`), 0600); err != nil {
		t.Fatal(err)
	}
	server, err := professionaldb.NewServer(professionaldb.Config{CredentialPath: credentials, OAuthHost: upstream.URL, APIURL: upstream.URL}, data, service.ProfessionalDatabaseEnabled)
	if err != nil {
		t.Fatal(err)
	}
	service.ProfessionalDatabaseHandler = server.Handler()
	service.ProfessionalDatabaseReady = server.Ready
	return service, &calls
}

func professionalGrant(t *testing.T, service *Service, username string, daily, monthly int) contracts.KimiDatasourceGrant {
	t.Helper()
	grant, err := service.SetKimiDatasource(t.Context(), username, contracts.KimiDatasourceGrant{Enabled: true, AllowedSources: []string{"wind", "arxiv"}, DailyLimit: daily, MonthlyLimit: monthly})
	if err != nil {
		t.Fatal(err)
	}
	return grant
}

func professionalRequest(handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

const professionalQuery = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_data_source_desc","arguments":{"name":"wind"}}}`

func TestProfessionalDatabaseServiceProjectsGrantsSourcesAndUsageBySID(t *testing.T) {
	service, calls := professionalServiceFixture(t)
	grant := professionalGrant(t, service, "ALICE", 2, 10)
	if grant.DailyUsed != 0 || !slices.Equal(grant.AllowedSources, []string{"arxiv", "wind"}) {
		t.Fatalf("normalized grant: %+v", grant)
	}
	users, sources, err := service.ListManagedUsers(t.Context())
	if err != nil || len(users) != 2 || len(sources) != 25 || !slices.Contains(sources, "caixin") {
		t.Fatalf("users/sources: %+v %v %v", users, sources, err)
	}
	if users[0].KimiDatasource == nil || users[0].KimiDatasource.DailyLimit != 2 || !users[0].KimiDatasource.Enabled {
		t.Fatalf("alice grant: %+v", users[0])
	}
	if users[1].KimiDatasource == nil || users[1].KimiDatasource.Enabled || users[1].KimiDatasource.DailyLimit != 0 {
		t.Fatalf("bob inherited alice grant: %+v", users[1])
	}
	sources[0] = "tampered"
	if professionaldb.Sources[0] == "tampered" {
		t.Fatal("list exposed mutable source catalog")
	}
	connection, err := service.professionalDatabaseConnection(t.Context(), "S-1-5-21-1000")
	if err != nil || connection.Endpoint != service.ProfessionalDatabaseURL || connection.Token == "" {
		t.Fatalf("connection unavailable: %v", err)
	}
	handler := Handler(service, "manager-token")
	response := professionalRequest(handler, "POST", "/professional-database/mcp", connection.Token, professionalQuery)
	if response.Code != 200 || strings.Contains(response.Body.String(), `"isError":true`) || calls.Load() != 1 {
		t.Fatalf("query: %d %s", response.Code, response.Body.String())
	}
	status, err := service.ProfessionalDatabaseStatus(t.Context(), "S-1-5-21-1000")
	if err != nil || !status.Configured || !status.UpstreamReady || status.Timezone != "Asia/Shanghai" || status.CountingRule == "" || status.DailyUsed != 1 || status.DailyRemaining != 1 || status.MonthlyRemaining != 9 {
		t.Fatalf("alice status: %+v %v", status, err)
	}
	bob, err := service.ProfessionalDatabaseStatus(t.Context(), "S-1-5-21-1001")
	if err != nil || bob.DailyUsed != 0 || bob.MonthlyUsed != 0 || bob.Enabled {
		t.Fatalf("bob usage crossed SID boundary: %+v %v", bob, err)
	}
	grant.DailyLimit, grant.MonthlyLimit = 0, 0
	grant.DailyUsed, grant.MonthlyUsed = 0, 0
	if _, err := service.SetKimiDatasource(t.Context(), "alice", grant); err != nil {
		t.Fatal(err)
	}
	status, _ = service.ProfessionalDatabaseStatus(t.Context(), "S-1-5-21-1000")
	if status.DailyRemaining != 0 || status.MonthlyRemaining != 0 || status.DailyUsed != 1 {
		t.Fatalf("lower limit reset history/negative remainder: %+v", status)
	}
}

func TestProfessionalDatabaseManagerAndEmployeeCredentialsCannotBypassEachOther(t *testing.T) {
	service, _ := professionalServiceFixture(t)
	professionalGrant(t, service, "alice", 2, 10)
	professionalGrant(t, service, "bob", 3, 10)
	alice, _ := service.professionalDatabaseConnection(t.Context(), "S-1-5-21-1000")
	bob, _ := service.professionalDatabaseConnection(t.Context(), "S-1-5-21-1001")
	handler := Handler(service, "manager-token")
	for _, token := range []string{"", "wrong", alice.Token, bob.Token} {
		for _, request := range []struct{ method, path, body string }{
			{"GET", "/v1/users", ""}, {"GET", "/v1/professional-database/S-1-5-21-1001", ""},
			{"POST", "/v1/professional-database/S-1-5-21-1001/connection", ""},
			{"POST", "/v1/users/kimi-datasource", `{"username":"bob","grant":{"enabled":false,"allowed_sources":[],"daily_limit":0,"monthly_limit":0}}`},
		} {
			response := professionalRequest(handler, request.method, request.path, token, request.body)
			if response.Code != 401 {
				t.Fatalf("employee accessed manager route %s: %d", request.path, response.Code)
			}
		}
	}
	for _, token := range []string{"", "wrong", "manager-token"} {
		response := professionalRequest(handler, "POST", "/professional-database/mcp", token, professionalQuery)
		if response.Code != 401 {
			t.Fatalf("manager token bypassed employee MCP authentication: %d", response.Code)
		}
	}
	_, aliceSecret, _ := strings.Cut(alice.Token, ".")
	response := professionalRequest(handler, "POST", "/professional-database/mcp", "S-1-5-21-1001."+aliceSecret, professionalQuery)
	if response.Code != 401 {
		t.Fatal("cross-SID token forgery accepted")
	}
	response = professionalRequest(handler, "GET", "/v1/professional-database/S-1-5-21-1000", "manager-token", "")
	if response.Code != 200 || strings.Contains(response.Body.String(), "token") || strings.Contains(response.Body.String(), "upstream-test-access") {
		t.Fatalf("status exposed credentials: %d %s", response.Code, response.Body.String())
	}
	response = professionalRequest(handler, "POST", "/v1/professional-database/S-1-5-21-1000/connection", "manager-token", "")
	var issued contracts.ProfessionalDatabaseConnection
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &issued) != nil || issued.Token != alice.Token {
		t.Fatal("manager protected connection endpoint failed to preserve token")
	}
	response = professionalRequest(handler, "GET", "/professional-database/v1/users", alice.Token, "")
	if response.Code != 404 {
		t.Fatalf("MCP route prefix exposed manager routes: %d", response.Code)
	}
}

func TestProfessionalDatabaseRejectsDisabledAndOffboardedEmployeeConnections(t *testing.T) {
	for _, offboarded := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "offboarded"}[offboarded], func(t *testing.T) {
			service, calls := professionalServiceFixture(t)
			professionalGrant(t, service, "alice", 2, 10)
			connection, _ := service.professionalDatabaseConnection(t.Context(), "S-1-5-21-1000")
			service.Users = listStore{users: []store.User{{Username: "alice", SID: "S-1-5-21-1000", Disabled: !offboarded, Offboarded: offboarded}}}
			if _, err := service.professionalDatabaseConnection(t.Context(), "S-1-5-21-1000"); err == nil || err.Error() != "professional_database_disabled" {
				t.Fatalf("inactive employee received installation token: %v", err)
			}
			handler := Handler(service, "manager-token")
			response := professionalRequest(handler, "POST", "/professional-database/mcp", connection.Token, professionalQuery)
			if response.Code != 403 || calls.Load() != 0 {
				t.Fatalf("issued token bypassed employee revocation: %d calls=%d", response.Code, calls.Load())
			}
			status, _ := service.ProfessionalDatabaseStatus(t.Context(), "S-1-5-21-1000")
			if status.DailyUsed != 0 {
				t.Fatal("revoked employee was charged")
			}
		})
	}
}

func TestProfessionalDatabaseAdminPolicyRouteAndUnavailableService(t *testing.T) {
	service, _ := professionalServiceFixture(t)
	handler := Handler(service, "manager-token")
	response := professionalRequest(handler, "POST", "/v1/users/kimi-datasource", "manager-token", `{"username":"alice","grant":{"enabled":true,"allowed_sources":["caixin"],"daily_limit":7,"monthly_limit":30}}`)
	var grant contracts.KimiDatasourceGrant
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &grant) != nil || grant.DailyLimit != 7 || !slices.Equal(grant.AllowedSources, []string{"caixin"}) {
		t.Fatalf("admin policy update: %d %s", response.Code, response.Body.String())
	}
	if _, err := service.SetKimiDatasource(t.Context(), "unknown", grant); err == nil {
		t.Fatal("unknown employee policy accepted")
	}
	service.ProfessionalDatabase = nil
	if _, err := service.SetKimiDatasource(t.Context(), "alice", grant); err == nil {
		t.Fatal("unavailable service accepted policy")
	}
	status, err := service.ProfessionalDatabaseStatus(context.Background(), "S-1-5-21-1000")
	if err != nil || status.Configured || status.Enabled || status.DailyRemaining != 0 {
		t.Fatalf("unavailable status: %+v %v", status, err)
	}
}

func TestProfessionalDatabaseCanBeInstalledBeforeUpstreamLoginWithoutCharging(t *testing.T) {
	service, calls := professionalServiceFixture(t)
	professionalGrant(t, service, "alice", 2, 10)
	server, err := professionaldb.NewServer(professionaldb.Config{}, service.ProfessionalDatabase, service.ProfessionalDatabaseEnabled)
	if err != nil {
		t.Fatal(err)
	}
	service.ProfessionalDatabaseReady, service.ProfessionalDatabaseHandler = server.Ready, server.Handler()
	status, err := service.ProfessionalDatabaseStatus(t.Context(), "S-1-5-21-1000")
	if err != nil || !status.Configured || status.UpstreamReady {
		t.Fatalf("pending login status: %+v %v", status, err)
	}
	connection, err := service.professionalDatabaseConnection(t.Context(), "S-1-5-21-1000")
	if err != nil || connection.Token == "" {
		t.Fatalf("pending login prevented installation: %v", err)
	}
	handler := Handler(service, "manager-token")
	response := professionalRequest(handler, "POST", "/professional-database/mcp", connection.Token, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"serverInfo"`) {
		t.Fatalf("pending login prevented handshake: %d %s", response.Code, response.Body.String())
	}
	response = professionalRequest(handler, "POST", "/professional-database/mcp", connection.Token, professionalQuery)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "PROFESSIONAL_DATABASE_NEEDS_AUTH") || !strings.Contains(response.Body.String(), `"isError":true`) {
		t.Fatalf("pending login query: %d %s", response.Code, response.Body.String())
	}
	status, _ = service.ProfessionalDatabaseStatus(t.Context(), "S-1-5-21-1000")
	if status.DailyUsed != 0 || status.MonthlyUsed != 0 || calls.Load() != 0 {
		t.Fatal("unconfigured upstream consumed quota")
	}
}
