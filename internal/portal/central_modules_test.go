package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/modelaccess"
	"workagent3/internal/quota"
	"workagent3/internal/store"
)

func TestCentralModulesInferSIDFromPortalSession(t *testing.T) {
	ctx := t.Context()
	const sid = "S-1-5-21-3000"
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(ctx, "alice", sid, "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(ctx, "alice-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	models, err := modelaccess.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer models.Close()
	model := modelaccess.Model{
		ID: "codex-native", ProviderID: "codex", DisplayName: "Codex",
		Aliases: []string{}, ContextWindow: 128000, Health: modelaccess.Healthy,
	}
	if err := models.UpsertModel(ctx, model); err != nil {
		t.Fatal(err)
	}
	if err := models.SetAuthorization(ctx, sid, model.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	quotas, err := quota.Open(":memory:", models)
	if err != nil {
		t.Fatal(err)
	}
	defer quotas.Close()
	if err := quotas.SetBudget(ctx, quota.Budget{SID: sid, ModelID: model.ID, Period: quota.Daily, LimitUnits: 100}); err != nil {
		t.Fatal(err)
	}

	server, err := NewWithModules(data, StaticRouter{}, false, Modules{ModelAccess: models, Quota: quotas})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, target, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://portal.test"+target, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "alice-session"})
		if method != http.MethodGet {
			req.Header.Set("Origin", "http://portal.test")
		}
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, req)
		return response
	}

	modelsResponse := request(http.MethodGet, "/api/models", "")
	if modelsResponse.Code != http.StatusOK || !strings.Contains(modelsResponse.Body.String(), `"authorized":true`) {
		t.Fatalf("models response %d: %s", modelsResponse.Code, modelsResponse.Body.String())
	}
	usageResponse := request(http.MethodGet, "/api/quota/usage?model_id=codex-native", "")
	if usageResponse.Code != http.StatusOK || !strings.Contains(usageResponse.Body.String(), `"limitUnits":100`) {
		t.Fatalf("quota response %d: %s", usageResponse.Code, usageResponse.Body.String())
	}
}

func TestCentralModulesRequireAuthentication(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	server, _ := NewWithModules(data, StaticRouter{}, false, Modules{})
	for _, target := range []string{"/api/models", "/api/quota/usage?model_id=codex-native"} {
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s returned %d", target, response.Code)
		}
	}
}
