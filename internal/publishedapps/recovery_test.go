package publishedapps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"workagent3/internal/winutil"
)

func TestLatestStatusReportsColdStartFailureWhenNoInstanceRuns(t *testing.T) {
	id := strings.Repeat("a", 24)
	r := &Runner{config: RunnerConfig{Root: t.TempDir()}, running: map[string]*applicationProcess{}, states: map[string]AppStatus{id + ":" + strings.Repeat("b", 24): {State: "failed", Error: "interpreter unavailable", LastActivity: time.Now()}}}
	status := r.Status(id, "")
	if status.State != "failed" || status.Error != "interpreter unavailable" {
		t.Fatal(status)
	}
}

func TestRecoverOnlyIdentifiedInterruptedSnapshots(t *testing.T) {
	root := t.TempDir()
	id := strings.Repeat("a", 24)
	version := strings.Repeat("b", 24)
	r := &Runner{config: RunnerConfig{Root: root}}
	directory, _ := r.versionPath(id, version)
	for _, target := range []string{directory, directory + ".staging", filepath.Join(filepath.Dir(directory), "unknown.staging")} {
		os.MkdirAll(target, 0700)
		os.WriteFile(filepath.Join(target, "content"), []byte("copy"), 0600)
	}
	if err := writeWorkerJSON(directory+".input.json", SnapshotInput{SourceRoot: root, Entry: "index.html", Destination: directory + ".staging", Manifest: Manifest{AppID: id, Version: version, Kind: "static"}}); err != nil {
		t.Fatal(err)
	}
	if err := r.recoverSnapshots(); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{directory, directory + ".staging", directory + ".input.json"} {
		if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("interrupted artifact survived: %s", target)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(directory), "unknown.staging", "content")); err != nil {
		t.Fatal("unidentified directory was removed")
	}
	if err := removeSnapshotArtifact(filepath.Dir(directory), root); err == nil {
		t.Fatal("cleanup accepted parent escape")
	}
}
func TestNetworkCleanupSurvivesRestartAndNeverRevokesLiveLease(t *testing.T) {
	root := t.TempDir()
	rule := winutil.AppNetworkRule{AppID: strings.Repeat("a", 24), Version: strings.Repeat("b", 24), BackendPort: 1234, BrokerPort: 2345}
	unavailable := false
	calls := 0
	config := RunnerConfig{Root: root, AuthorizeNetwork: func(context.Context, winutil.AppNetworkRule) (string, error) { return "identity", nil }, RevokeNetwork: func(context.Context, winutil.AppNetworkRule) error {
		calls++
		if unavailable {
			return errors.New("offline")
		}
		return nil
	}}
	r := &Runner{config: config, networkCleanup: map[string]winutil.AppNetworkRule{}}
	if _, err := r.authorizeNetwork(t.Context(), rule); err != nil {
		t.Fatal(err)
	}
	r.retryNetworkCleanup()
	if calls != 0 {
		t.Fatal("live lease revoked")
	}
	unavailable = true
	r.revokeNetwork(rule)
	restarted := &Runner{config: config, networkCleanup: map[string]winutil.AppNetworkRule{}}
	if err := restarted.loadNetworkCleanup(); err != nil {
		t.Fatal(err)
	}
	if len(restarted.networkCleanup) != 1 {
		t.Fatal("failed revocation lost")
	}
	unavailable = false
	restarted.retryNetworkCleanup()
	if len(restarted.networkCleanup) != 0 {
		t.Fatal("revocation not retried")
	}
	if _, err := os.Stat(r.networkLeasePath(rule)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("completed lease retained")
	}
}
