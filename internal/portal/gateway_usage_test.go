package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/quota"
	"workagent3/internal/store"
)

func TestGatewayUsageEndpointServesDrainedAuthoritativeUsage(t *testing.T) {
	ctx := t.Context()
	const sid = "S-1-5-21-3100"
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(ctx, "carol", sid, "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(ctx, "carol-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	quotas, err := quota.Open(":memory:", sharedTurnAuthorizerStub{})
	if err != nil {
		t.Fatal(err)
	}
	defer quotas.Close()
	if err := quotas.RecordGatewayUsage(ctx, contracts.GatewayUsageRecord{
		RequestID: "req-1", SID: sid, Provider: "openai", Model: "gpt-5.6-sol", Alias: "gpt-5.6-sol",
		Endpoint: "POST /v1/responses", AuthType: "api_key", TotalTokens: 77, OccurredAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	server, err := NewWithModules(data, StaticRouter{}, false, Modules{Quota: quotas})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://portal.test/api/quota/gateway-usage", nil)
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "carol-session"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("gateway usage response %d: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"dailyTokens":77`) || !strings.Contains(body, `"weeklyTokens":77`) ||
		!strings.Contains(body, `"model":"gpt-5.6-sol"`) {
		t.Fatalf("gateway usage body: %s", body)
	}

	// The endpoint requires authentication and a configured quota module.
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/quota/gateway-usage", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated gateway usage returned %d", response.Code)
	}
	bare, err := NewWithModules(data, StaticRouter{}, false, Modules{})
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "http://portal.test/api/quota/gateway-usage", nil)
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "carol-session"})
	response = httptest.NewRecorder()
	bare.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("quota-less gateway usage returned %d", response.Code)
	}
}
