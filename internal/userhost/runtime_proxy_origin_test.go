package userhost

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"workagent3/internal/portal"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestPublicPluginInventoryUsesInternalOriginAfterPortalValidation(t *testing.T) {
	calls := 0
	harness := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Origin") != "http://"+r.Host || !strings.HasPrefix(r.Host, "127.0.0.1:") {
			http.Error(w, "forbidden", 403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"entries":[]}`))
	}))
	defer harness.Close()
	target, _ := url.Parse(harness.URL)
	gateway := httptest.NewServer(newRuntimeGatewayHandlerWithControl(nil, nil, nil, nil, nil, nil, nil, target, "runtime-token", nil, nil, nil, "", nil, nil, nil))
	defer gateway.Close()
	gatewayURL, _ := url.Parse(gateway.URL)
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-100", "hash")
	data.CreateSession(t.Context(), "session", user.ID, time.Now().Add(time.Hour))
	server, _ := portal.New(data, portal.StaticRouter{user.SID: runtimeapi.Endpoint{BaseURL: gatewayURL, Token: "runtime-token"}}, false)
	for _, tc := range []struct {
		origin, session string
		want            int
	}{{"http://workagent.example", "session", 200}, {"http://evil.example", "session", 403}, {"http://workagent.example", "invalid", 401}} {
		request := httptest.NewRequest("POST", "http://workagent.example/api/pluginInventory/list", strings.NewReader(`{}`))
		request.Header.Set("Origin", tc.origin)
		request.AddCookie(&http.Cookie{Name: "workagent-session", Value: tc.session})
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != tc.want {
			t.Fatalf("origin=%s status=%d body=%s", tc.origin, response.Code, response.Body.String())
		}
	}
	if calls != 1 {
		t.Fatalf("untrusted requests reached Harness: %d", calls)
	}
}
