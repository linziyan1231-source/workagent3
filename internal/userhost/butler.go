package userhost

import (
	"net/http"
	"regexp"
	"strings"
)

var butlerRoutes = map[string]*regexp.Regexp{
	"GET":    regexp.MustCompile(`^(/v1/(system/status|models|credentials|capabilities|presets|skills|mcp-servers|workspaces|sessions|runtime-settings|capability-sync/status|completion-notifications/targets)|/v1/(presets|skills|sessions)/[A-Za-z0-9_:@.-]+|/dsh-im-connect/api/(channels|assistant|projects)|/dsh-im-connect/api/channels/[A-Za-z0-9_:@.-]+/qr/status)$`),
	"POST":   regexp.MustCompile(`^(/v1/(presets|mcp-servers|credentials|imports/mcp|capability-sync/run|completion-notifications/send|session-tools)|/v1/mcp-servers/[A-Za-z0-9_:@.-]+/test|/v1/presets/[A-Za-z0-9_:@.-]+/copy|/v1/sessions/[A-Za-z0-9_:@.-]+/capabilities/reload|/dsh-im-connect/api/assistant|/dsh-im-connect/api/accounts/[A-Za-z0-9_:@.-]+/(settings|receive|reconnect|check|remove|approve|deny)|/dsh-im-connect/api/channels/[A-Za-z0-9_:@.-]+/(connect|receive|disconnect|remove)|/dsh-im-connect/api/channels/[A-Za-z0-9_:@.-]+/qr/(start|refresh|cancel))$`),
	"PATCH":  regexp.MustCompile(`^/v1/(presets|skills|mcp-servers)/[A-Za-z0-9_:@.-]+$`),
	"DELETE": regexp.MustCompile(`^/v1/(presets|skills|mcp-servers|credentials)/[A-Za-z0-9_:@.-]+$`),
}

func allowedButlerRequest(r *http.Request) bool {
	if r.URL.RawQuery != "" || strings.ContainsAny(r.URL.EscapedPath(), `%\`) || strings.Contains(r.URL.Path, "..") {
		return false
	}
	rule := butlerRoutes[r.Method]
	return rule != nil && rule.MatchString(r.URL.Path)
}
