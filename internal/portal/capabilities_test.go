package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestCapabilityReadModelAggregatesPlatformAndRuntimeManifests(t *testing.T) {
	users, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	user, err := users.CreateUser(t.Context(), "alice", "S-1-5-21-5201", "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err := users.CreateSession(t.Context(), "capability-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	runtime := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/capabilities" || request.Header.Get("Authorization") != "Bearer private-runtime-token" {
			http.NotFound(writer, request)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{
			"modules": []contracts.ModuleManifest{{
				ID: "runtime-api", Version: "1.0.0", Layer: "runtime", Required: true,
				Capabilities: []string{"runtime.health"}, Dependencies: []contracts.ModuleDependency{},
				ConfigSchema: "workagent://schemas/runtime-api/v1", DataOwner: "none; routing only", HealthCheck: "/health",
			}},
			"engines": map[string]any{"harness": map[string]bool{"approval": true, "resume": true, "steer": true, "toolEvents": true, "usage": true}},
		})
	}))
	defer runtime.Close()
	target, _ := url.Parse(runtime.URL)
	server, err := New(users, StaticRouter{user.SID: runtimeapi.Endpoint{BaseURL: target, Token: "private-runtime-token"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/system/capabilities", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d", unauthenticated.Code)
	}
	response := systemRequest(handler, http.MethodGet, "/api/system/capabilities", "capability-session")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var model contracts.CapabilityReadModel
	if err := json.Unmarshal(response.Body.Bytes(), &model); err != nil {
		t.Fatal(err)
	}
	if model.SchemaVersion != 1 || model.RuntimeStatus != "healthy" || len(model.RuntimeModules) != 1 || len(model.PlatformModules) != len(platformModuleManifests()) {
		t.Fatalf("read model = %#v", model)
	}
	if err := contracts.ValidateModuleGraph(platformModuleManifests()); err != nil {
		t.Fatal(err)
	}
	for _, entry := range model.PlatformModules {
		if entry.Status != "healthy" && entry.Status != "disabled" && entry.Status != "unknown" {
			t.Fatalf("invalid platform status = %#v", entry)
		}
	}
	for _, secret := range []string{user.SID, "private-runtime-token", runtime.URL} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatalf("capability response leaked %q", secret)
		}
	}
}

func TestCapabilityReadModelKeepsPlatformVisibleWhenRuntimeUnavailable(t *testing.T) {
	users, err := store.Open(filepath.Join(t.TempDir(), "portal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	user, _ := users.CreateUser(t.Context(), "alice", "S-1-5-21-5202", "unused")
	_ = users.CreateSession(t.Context(), "capability-session", user.ID, time.Now().Add(time.Hour))
	server, err := New(users, StaticRouter{}, false)
	if err != nil {
		t.Fatal(err)
	}
	response := systemRequest(server.Handler(), http.MethodGet, "/api/system/capabilities", "capability-session")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var model contracts.CapabilityReadModel
	if err := json.Unmarshal(response.Body.Bytes(), &model); err != nil {
		t.Fatal(err)
	}
	if model.RuntimeStatus != "unavailable" || len(model.RuntimeModules) != 0 || len(model.PlatformModules) == 0 {
		t.Fatalf("read model = %#v", model)
	}
}
