package userhost

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentProxyForwardsListAndPublishUnderOwnSID(t *testing.T) {
	var gotPath, gotBody, gotAuth, gotMethod string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"items":[]}`))
	}))
	defer upstream.Close()
	g := &publishedApplicationGateway{platformURL: upstream.URL, platformCredential: "cred", sid: "S-1-x"}

	w := httptest.NewRecorder()
	g.agentProxy(w, httptest.NewRequest("GET", "/v1/app-publishing", nil))
	if w.Code != 200 || gotPath != "/internal/runtime/published-apps/list" || gotMethod != "POST" {
		t.Fatalf("list forward: %d %s %s", w.Code, gotMethod, gotPath)
	}
	if gotAuth != "Bearer cred" || gotBody != `{"sid":"S-1-x"}` {
		t.Fatalf("list forward auth/body: %q %q", gotAuth, gotBody)
	}

	w = httptest.NewRecorder()
	g.agentProxy(w, httptest.NewRequest("POST", "/v1/app-publishing/publish", strings.NewReader(`{"name":"站点","sid":"S-1-forged"}`)))
	if gotPath != "/internal/runtime/published-apps/publish" {
		t.Fatalf("publish forward: %s", gotPath)
	}
	var forwarded map[string]any
	if json.Unmarshal([]byte(gotBody), &forwarded) != nil || forwarded["sid"] != "S-1-x" || forwarded["name"] != "站点" {
		t.Fatalf("publish forward body: %s", gotBody)
	}

	w = httptest.NewRecorder()
	g.agentProxy(w, httptest.NewRequest("POST", "/v1/app-publishing", nil))
	if w.Code != 405 {
		t.Fatalf("list accepts only GET: %d", w.Code)
	}
	w = httptest.NewRecorder()
	g.agentProxy(w, httptest.NewRequest("GET", "/v1/app-publishing/publish", nil))
	if w.Code != 405 {
		t.Fatalf("publish accepts only POST: %d", w.Code)
	}
}
