package userhost

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestPublishedSourceUsesHarnessDirectoryAndDefaultRoot(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{".workagent-unassigned", "实际项目目录"} {
		os.Mkdir(filepath.Join(root, name), 0700)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/workspaces" || r.Header.Get("Authorization") != "Bearer harness" {
			t.Error("workspace authorization missing")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"workspace-1","directory":"实际项目目录"},{"id":"invalid-1","directory":"../private"}]`))
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	feature := publishedApplicationGateway{workspaceRoot: root, target: target, token: "harness", client: server.Client()}
	for id, want := range map[string]string{"default": ".workagent-unassigned", "workspace-1": "实际项目目录"} {
		got, err := feature.source(t.Context(), id)
		if err != nil || got != filepath.Join(root, want) {
			t.Fatalf("%s: %s %v", id, got, err)
		}
	}
	for _, id := range []string{"invalid-1", "unknown", "../private"} {
		if _, err := feature.source(t.Context(), id); err == nil {
			t.Fatalf("unapproved workspace %s resolved", id)
		}
	}
}
