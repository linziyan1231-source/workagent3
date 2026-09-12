package userhost

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"workagent3/internal/acpcatalog"
)

func TestAcpCatalogCredentialScopeAndRedaction(t *testing.T) {
	entry := acpcatalog.Entry{ID: "approved", Label: "Approved", Revision: "v1", PackageRef: "public/v1", Command: "agent.exe", Args: []string{}, Enabled: true, BillingModelID: "fixed", CredentialFields: []acpcatalog.CredentialField{{ID: "key", Label: "API key", Environment: "APP_API_KEY", Required: true}}}
	enabled := true
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/runtime/acp-catalog" || r.Header.Get("Authorization") != "Bearer platform" {
			t.Error("unexpected platform request")
			w.WriteHeader(403)
			return
		}
		var input struct {
			SID      string
			ID       string
			Revision string
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.SID != "S-1-5-21-1000" {
			t.Error("employee ownership changed")
		}
		if !enabled && input.ID != "" {
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"error":"acp_catalog_disabled"}`))
			return
		}
		if input.ID == "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"entries": []acpcatalog.Entry{entry}})
		} else {
			_ = json.NewEncoder(w).Encode(entry)
		}
	}))
	defer portal.Close()
	platform, _ := newAuditClient(portal.URL, "platform", "S-1-5-21-1000")
	handler := acpCatalogHandler(openGatewayCredentials(t), platform, "browser", "harness-only")
	send := func(method, path, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, token := range []string{"browser", "butler", ""} {
		if w := send("GET", "/internal/acp-catalog/approved/credentials", token, ""); w.Code != 401 {
			t.Fatalf("private credentials accepted %q: %d", token, w.Code)
		}
	}
	if w := send("GET", "/v1/acp-catalog", "harness-only", ""); w.Code != 401 {
		t.Fatal("private scope accepted public mutation scope")
	}
	if w := send("PUT", "/v1/acp-catalog/approved/credentials", "browser", `{"values":{"PATH":"not-allowed"}}`); w.Code != 400 {
		t.Fatal("accepted undeclared field")
	}
	saved := send("PUT", "/v1/acp-catalog/approved/credentials", "browser", `{"values":{"key":"private-value"}}`)
	if saved.Code != 200 || strings.Contains(saved.Body.String(), "private-value") || strings.Contains(saved.Body.String(), "APP_API_KEY") {
		t.Fatalf("unsafe save response %d: %s", saved.Code, saved.Body.String())
	}
	metadata := send("GET", "/v1/acp-catalog", "browser", "")
	if metadata.Code != 200 || strings.Contains(metadata.Body.String(), "private-value") || strings.Contains(metadata.Body.String(), "agent.exe") || !strings.Contains(metadata.Body.String(), `"configured":true`) {
		t.Fatalf("bad metadata %s", metadata.Body.String())
	}
	secret := send("GET", "/internal/acp-catalog/approved/credentials?revision=v1", "harness-only", "")
	if secret.Code != 200 || !strings.Contains(secret.Body.String(), `"APP_API_KEY":"private-value"`) {
		t.Fatalf("private resolve failed %d", secret.Code)
	}
	enabled = false
	if w := send("GET", "/internal/acp-catalog/approved/credentials?revision=v1", "harness-only", ""); w.Code != 409 {
		t.Fatal("disabled engine resolved credentials")
	}
}
