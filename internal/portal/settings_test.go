package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	clientsettings "workagent3/internal/settings"
	"workagent3/internal/store"
)

func TestClientSettingsUseAuthenticatedSID(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-4000", "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(t.Context(), "settings-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	settingsData, err := clientsettings.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer settingsData.Close()
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{Settings: settingsData})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, target, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://portal.test"+target, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "settings-session"})
		if method != http.MethodGet {
			req.Header.Set("Origin", "http://portal.test")
		}
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, req)
		return response
	}
	put := request(http.MethodPut, "/api/settings/client", `{"acp.promptTimeout":180}`)
	if put.Code != http.StatusNoContent {
		t.Fatalf("PUT returned %d: %s", put.Code, put.Body.String())
	}
	get := request(http.MethodGet, "/api/settings/client?keys=acp.promptTimeout", "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"acp.promptTimeout":180`) {
		t.Fatalf("GET returned %d: %s", get.Code, get.Body.String())
	}
	foreign := request(http.MethodGet, "/api/settings/client?keys=mcp.config", "")
	if foreign.Code != http.StatusOK || strings.TrimSpace(foreign.Body.String()) != `{}` {
		t.Fatalf("foreign key GET returned %d: %s", foreign.Code, foreign.Body.String())
	}
	rejected := request(http.MethodPut, "/api/settings/client", `{"mcp.config":[]}`)
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("foreign key PUT returned %d: %s", rejected.Code, rejected.Body.String())
	}
}
