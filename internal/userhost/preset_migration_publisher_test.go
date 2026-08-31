package userhost

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/skillmigration"
)

func TestHarnessPresetMigrationPublisherRecordsTerminalResults(t *testing.T) {
	root := t.TempDir()
	ingress := filepath.Join(root, "preset-migration.json")
	payload := `{"schemaVersion":1,"sid":"S-1-5-21-1","capturedAt":"2026-09-01T00:00:00Z","presets":[]}`
	if err := os.WriteFile(ingress, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	var received string
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/preset-migration" || request.Method != http.MethodPut || request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Fatalf("unexpected migration request %s %s", request.Method, request.URL.Path)
		}
		body, _ := io.ReadAll(request.Body)
		received = string(body)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"results":[{"sourceId":"assistant","targetId":"legacy-preset:assistant","kind":"preset","status":"ready"}]}`))
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	skills := openGatewaySkills(t)
	migration, err := skillmigration.Open(filepath.Join(root, "migration.db"), skills, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer migration.Close()
	publisher := &harnessPresetMigrationPublisher{path: ingress, target: target, token: "runtime-token", client: &http.Client{Timeout: time.Second}, migration: migration}
	if err := publisher.Publish(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(received, `"sid":"S-1-5-21-1"`) {
		t.Fatalf("migration ingress was not forwarded: %s", received)
	}
	results, err := migration.PresetResults(context.Background())
	if err != nil || len(results) != 1 || results[0].Status != skillmigration.Ready {
		t.Fatalf("Preset journal = %#v, %v", results, err)
	}
}

func TestHarnessPresetMigrationPublisherIgnoresMissingIngress(t *testing.T) {
	publisher := &harnessPresetMigrationPublisher{path: filepath.Join(t.TempDir(), "missing.json")}
	if err := publisher.Publish(context.Background()); err != nil {
		t.Fatal(err)
	}
}
