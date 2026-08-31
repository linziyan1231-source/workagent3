package userhost

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillruntime"
)

func TestHarnessSkillProjectionKeepsRootsOnPrivateRoute(t *testing.T) {
	store := openGatewaySkills(t)
	source := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: drawing-review\ndescription: Reviews drawings\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	entry, err := store.Install(context.Background(), skillruntime.InstallInput{
		Entry:           skillruntime.Entry{ID: "drawing-review", Name: "Drawing Review", Description: "Reviews drawings", Version: "1", Source: "user", Enabled: true},
		SourceDirectory: source,
	})
	if err != nil {
		t.Fatal(err)
	}
	var received string
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/skill-projection" || request.Method != http.MethodPut || request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Fatalf("unexpected projection request %s %s", request.Method, request.URL.Path)
		}
		body, _ := io.ReadAll(request.Body)
		received = string(body)
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	publisher := &harnessSkillProjectionPublisher{store: store, target: target, token: "runtime-token", client: &http.Client{Timeout: time.Second}}
	if err := publisher.Publish(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(received, `"id":"drawing-review"`) || !strings.Contains(received, `"root":`) || !strings.Contains(received, filepath.Base(store.RootFor(entry))) ||
		!strings.Contains(received, `"requiredMcpServerIds":[]`) || !strings.Contains(received, `"requiredCommands":[]`) {
		t.Fatalf("projection did not contain installed skill root: %s", received)
	}
}

func TestResolveSkillEntryReportsMissingCommands(t *testing.T) {
	entry := skillruntime.Entry{ID: "office", RequiredCommands: []string{"officecli"}}
	resolved := resolveSkillEntry(entry, func(command string) (string, error) {
		if command != "officecli" {
			t.Fatalf("unexpected command %q", command)
		}
		return "", errors.New("not found")
	})
	if resolved.Health != "unavailable" || resolved.UnavailableReason != "command_not_found:officecli" {
		t.Fatalf("resolved entry = %#v", resolved)
	}
}

func TestRuntimeGatewayRejectsEnablingSkillWithMissingCommand(t *testing.T) {
	store := openGatewaySkills(t)
	source := filepath.Join(t.TempDir(), "missing-command-skill")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: missing-command\ndescription: Missing command\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := store.Install(t.Context(), skillruntime.InstallInput{
		Entry: skillruntime.Entry{
			ID: "missing-command", Name: "Missing Command", Version: "1", Source: "managed", Enabled: false,
			RequiredCommands: []string{"workagent-command-that-does-not-exist"},
		},
		SourceDirectory: source,
	})
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := openEmptyMCPCatalog(t)
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, store, gatewayTestPublisher{}, nil, nil, target, "token")
	request := httptest.NewRequest(http.MethodPatch, "/v1/skills/missing-command", strings.NewReader(`{"enabled":true}`))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "skill_dependency_unavailable:command_not_found:workagent-command-that-does-not-exist") {
		t.Fatalf("enable response %d: %s", response.Code, response.Body.String())
	}
}

func TestRuntimeGatewayOwnsSkillMutations(t *testing.T) {
	store := openGatewaySkills(t)
	source := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: user-skill\ndescription: User skill\n---\nskill"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := store.Install(context.Background(), skillruntime.InstallInput{
		Entry: skillruntime.Entry{ID: "user-skill", Name: "User Skill", Version: "1", Source: "user", Enabled: true}, SourceDirectory: source,
	})
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := openEmptyMCPCatalog(t)
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	handler := newRuntimeGatewayHandler(catalog, openGatewayCredentials(t), gatewayTestPublisher{}, store, gatewayTestPublisher{}, nil, nil, target, "token")

	patch := httptest.NewRequest(http.MethodPatch, "/v1/skills/user-skill", strings.NewReader(`{"enabled":false}`))
	patch.Header.Set("Authorization", "Bearer token")
	patched := httptest.NewRecorder()
	handler.ServeHTTP(patched, patch)
	if patched.Code != http.StatusOK || !strings.Contains(patched.Body.String(), `"enabled":false`) {
		t.Fatalf("patch response %d: %s", patched.Code, patched.Body.String())
	}

	remove := httptest.NewRequest(http.MethodDelete, "/v1/skills/user-skill", nil)
	remove.Header.Set("Authorization", "Bearer token")
	removed := httptest.NewRecorder()
	handler.ServeHTTP(removed, remove)
	if removed.Code != http.StatusNoContent {
		t.Fatalf("delete response %d: %s", removed.Code, removed.Body.String())
	}
}

func openEmptyMCPCatalog(t *testing.T) (*mcpruntime.Catalog, error) {
	t.Helper()
	catalog, err := mcpruntime.Open(":memory:")
	if err == nil {
		t.Cleanup(func() { _ = catalog.Close() })
	}
	return catalog, err
}
