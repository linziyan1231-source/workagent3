package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
	"workagent3/internal/notifications"
	"workagent3/internal/runtimeapi"
)

// Explicit opt-in loopback fixture for the dual-browser acceptance script.
// Stores, users and ACL adapters are isolated test fixtures, never production.
func TestCollaborationBrowserFixture(t *testing.T) {
	path := os.Getenv("WORKAGENT_COLLAB_FIXTURE_FILE")
	if path == "" {
		t.Skip("browser fixture not requested")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/model-options" {
			writeSharedModelFixture(w)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"builtin-codex","name":"Codex","engine":"codex","enabled":true},{"id":"builtin-kimi","name":"Kimi","engine":"kimi","enabled":true},{"id":"not-joined","name":"未加入助手","engine":"codex","enabled":true}]`))
	}))
	defer upstream.Close()
	endpoint, _ := url.Parse(upstream.URL)
	runner := &groupTurnFixture{requests: make(chan SharedTurnRequest, 100), release: make(chan struct{})}
	close(runner.release)
	notices, err := notifications.Open(filepath.Join(t.TempDir(), "notifications.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer notices.Close()
	handler, _, _, alice, bob := collaborationTestServer(t, func(s *Server) {
		s.runtimes = StaticRouter{"S-1-5-21-1000": runtimeapi.Endpoint{BaseURL: endpoint, Token: "fixture-token"}}
		s.modules.ModelAccess = groupModelAccess{}
		s.modules.SharedTurns = runner
		s.modules.Notifications = notices
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	value, _ := json.Marshal(map[string]any{"url": server.URL, "owner": alice.session, "member": bob.session})
	if err := os.WriteFile(path, value, 0600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	deadline := time.NewTimer(10 * time.Minute)
	defer deadline.Stop()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("browser fixture timed out")
		case <-ticker.C:
			if _, err := os.Stat(path + ".stop"); err == nil {
				return
			}
		}
	}
}
