package userhost

import (
	"net/http/httptest"
	"testing"
)

func TestButlerScope(t *testing.T) {
	for _, test := range []struct {
		method, path string
		allowed      bool
	}{
		{"GET", "/v1/capability-sync/status", true},
		{"GET", "/v1/completion-notifications/targets", true},
		{"POST", "/v1/completion-notifications/send", true},
		{"POST", "/v1/completion-notifications/targets", false},
		{"POST", "/dsh-im-connect/api/accounts/weixin:one/settings", true},
		{"POST", "/v1/imports/mcp", true},
		{"POST", "/internal/mcp-projection", false},
		{"POST", "/v1/sessions/one/turns", false},
		{"GET", "/v1/skills/../../internal/test", false},
		{"GET", "/v1/skills/%2e%2e", false},
		{"GET", "/api/admin/employees", false},
	} {
		if got := allowedButlerRequest(httptest.NewRequest(test.method, test.path, nil)); got != test.allowed {
			t.Errorf("%s %s: got %v", test.method, test.path, got)
		}
	}
}
