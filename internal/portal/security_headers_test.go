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

func TestSecurityPolicyAllowsOnlyExplicitWorkspaceContentPreviewToFrame(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	server, _ := New(data, StaticRouter{}, false)

	preview := httptest.NewRecorder()
	server.Handler().ServeHTTP(preview, httptest.NewRequest(http.MethodGet, "/api/runtime/v1/workspaces/workspace-1/content?path=final.pdf&preview=1", nil))
	if policy := preview.Header().Get("Content-Security-Policy"); !strings.Contains(policy, "frame-ancestors 'self'") {
		t.Fatalf("workspace preview CSP = %s", policy)
	}

	ordinary := httptest.NewRecorder()
	server.Handler().ServeHTTP(ordinary, httptest.NewRequest(http.MethodGet, "/api/runtime/v1/sessions?preview=1", nil))
	if policy := ordinary.Header().Get("Content-Security-Policy"); !strings.Contains(policy, "frame-ancestors 'none'") {
		t.Fatalf("ordinary CSP = %s", policy)
	}

	active := httptest.NewRecorder()
	server.Handler().ServeHTTP(active, httptest.NewRequest(http.MethodGet, "/api/runtime/v1/workspaces/workspace-1/content?path=active.html&preview=1", nil))
	if policy := active.Header().Get("Content-Security-Policy"); !strings.Contains(policy, "frame-ancestors 'none'") {
		t.Fatalf("active-content CSP = %s", policy)
	}
}

func TestSecurityPolicyAllowsOfficePreviewRoutesToFrame(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	server, _ := New(data, StaticRouter{}, false)

	converted := httptest.NewRecorder()
	server.Handler().ServeHTTP(converted, httptest.NewRequest(http.MethodGet, "/api/runtime/v1/office-preview/content/"+strings.Repeat("ab", 32)+".pdf", nil))
	if policy := converted.Header().Get("Content-Security-Policy"); !strings.Contains(policy, "frame-ancestors 'self'") {
		t.Fatalf("converted office preview CSP = %s", policy)
	}

	shared := httptest.NewRecorder()
	server.Handler().ServeHTTP(shared, httptest.NewRequest(http.MethodGet, "/api/portal/shared-office-preview?project_id=project_1234567890&path=deck.pptx", nil))
	if policy := shared.Header().Get("Content-Security-Policy"); !strings.Contains(policy, "frame-ancestors 'self'") {
		t.Fatalf("shared office preview CSP = %s", policy)
	}

	// The convert trigger is a POST and must never be frameable.
	trigger := httptest.NewRecorder()
	server.Handler().ServeHTTP(trigger, httptest.NewRequest(http.MethodGet, "/api/runtime/v1/office-preview/convert", nil))
	if policy := trigger.Header().Get("Content-Security-Policy"); !strings.Contains(policy, "frame-ancestors 'none'") {
		t.Fatalf("office preview convert CSP = %s", policy)
	}
}
