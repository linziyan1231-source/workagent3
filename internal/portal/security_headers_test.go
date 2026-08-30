package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"workagent3/internal/store"
)

func TestSecurityPolicyAllowsRendererStylesButNotInlineScripts(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	server, _ := New(data, StaticRouter{}, false)
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	policy := response.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "style-src 'self' 'unsafe-inline'") || strings.Contains(policy, "script-src 'unsafe-inline'") {
		t.Fatalf("unexpected renderer CSP: %s", policy)
	}
}
