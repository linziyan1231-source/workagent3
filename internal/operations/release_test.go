package operations

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
)

type capturedPublisher struct {
	inputs []contracts.NotificationInput
}

func (p *capturedPublisher) Publish(_ context.Context, input contracts.NotificationInput) (contracts.Notification, error) {
	p.inputs = append(p.inputs, input)
	return contracts.Notification{ID: "upgrade-test", Kind: input.Kind, Title: input.Title, Message: input.Message}, nil
}

func TestReleaseActivationRequiresNoticeAndRealReadinessThenRollsBackIndependently(t *testing.T) {
	store := openTestStore(t)
	base := time.Date(2026, 8, 31, 1, 2, 3, 0, time.UTC)
	first := makeTestRelease(t, "1.0.0", map[Component]string{ComponentWeb: "web-one", ComponentPortal: "portal-one"})
	if _, err := store.Install(t.Context(), first.root, first.manifest, base); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(t.Context(), "1.0.0", base.Add(time.Hour)); err == nil {
		t.Fatal("release activated without an upgrade notification")
	}
	publisher := &capturedPublisher{}
	if _, err := store.PublishUpgrade(t.Context(), "1.0.0", publisher, base.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if len(publisher.inputs) != 1 || publisher.inputs[0].TargetSID != "*" || !strings.Contains(publisher.inputs[0].Message, "不会中断") {
		t.Fatalf("unexpected management notification: %#v", publisher.inputs)
	}
	readiness := passingReadiness(base.Add(2 * time.Second))
	if err := store.RecordReadiness(t.Context(), "1.0.0", readiness); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(t.Context(), "1.0.0", base.Add(60*time.Second)); err == nil {
		t.Fatal("release activated before the notification was 60 seconds old")
	}
	firstActivation, err := store.Activate(t.Context(), "1.0.0", base.Add(61*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	active, err := store.Active(t.Context())
	if err != nil || active[ComponentWeb] != "1.0.0" || active[ComponentPortal] != "1.0.0" {
		t.Fatalf("unexpected first activation: %#v %v", active, err)
	}

	second := makeTestRelease(t, "1.1.0", map[Component]string{ComponentWeb: "web-two"})
	if _, err := store.Install(t.Context(), second.root, second.manifest, base.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishUpgrade(t.Context(), "1.1.0", publisher, base.Add(time.Hour+time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordReadiness(t.Context(), "1.1.0", passingReadiness(base.Add(time.Hour+2*time.Second))); err != nil {
		t.Fatal(err)
	}
	secondActivation, err := store.Activate(t.Context(), "1.1.0", base.Add(time.Hour+61*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	active, _ = store.Active(t.Context())
	if active[ComponentWeb] != "1.1.0" || active[ComponentPortal] != "1.0.0" {
		t.Fatalf("component activation was not independent: %#v", active)
	}
	firstStatus, err := store.Status(t.Context(), "1.0.0")
	if err != nil || firstStatus.State != "active" {
		t.Fatalf("partially active release lost active state: %#v %v", firstStatus, err)
	}
	rolledBack, err := store.Rollback(t.Context(), secondActivation.ID, base.Add(2*time.Hour))
	if err != nil || rolledBack.State != "rolled_back" {
		t.Fatalf("rollback failed: %#v %v", rolledBack, err)
	}
	active, _ = store.Active(t.Context())
	if active[ComponentWeb] != "1.0.0" || active[ComponentPortal] != "1.0.0" {
		t.Fatalf("rollback did not restore component pointers: %#v", active)
	}
	if _, err := store.Rollback(t.Context(), secondActivation.ID, base.Add(3*time.Hour)); err == nil {
		t.Fatal("already rolled-back activation was accepted twice")
	}
	_ = firstActivation
}

func TestRuntimeReleaseUsesInterruptionNoticeAndRejectsUnknownComponents(t *testing.T) {
	notice, err := NoticeFor([]Component{ComponentWeb, ComponentUserHost})
	if err != nil || notice.InterruptionClass != "runtime" || !strings.Contains(notice.Message, "可能会中断") {
		t.Fatalf("unexpected runtime notice: %#v %v", notice, err)
	}
	if _, err := NoticeFor([]Component{"aioncore"}); err == nil {
		t.Fatal("unknown component was accepted")
	}
}

func TestActivationReverifiesImmutableArtifactsAndAllReadinessProbes(t *testing.T) {
	store := openTestStore(t)
	base := time.Date(2026, 8, 31, 2, 0, 0, 0, time.UTC)
	release := makeTestRelease(t, "2.0.0", map[Component]string{ComponentWeb: "original"})
	if _, err := store.Install(t.Context(), release.root, release.manifest, base); err != nil {
		t.Fatal(err)
	}
	publisher := &capturedPublisher{}
	if _, err := store.PublishUpgrade(t.Context(), "2.0.0", publisher, base); err != nil {
		t.Fatal(err)
	}
	failed := passingReadiness(base.Add(time.Second))
	failed.Kimi.OK = false
	if err := store.RecordReadiness(t.Context(), "2.0.0", failed); err == nil {
		t.Fatal("failed Kimi readiness was accepted")
	}
	if err := store.RecordReadiness(t.Context(), "2.0.0", passingReadiness(base.Add(time.Second))); err != nil {
		t.Fatal(err)
	}
	installedArtifact := filepath.Join(store.releaseRoot, "2.0.0", filepath.FromSlash(release.manifest.Artifacts[0].File))
	if err := os.WriteFile(installedArtifact, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Activate(t.Context(), "2.0.0", base.Add(61*time.Second)); err == nil {
		t.Fatal("tampered immutable artifact activated")
	}
}

func TestInstallRecoversOperationsRecordAfterDirectoryCommit(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "operations.db")
	releaseRoot := filepath.Join(root, "releases")
	release := makeTestRelease(t, "5.0.0", map[Component]string{ComponentPortal: "portal"})
	store, err := Open(databasePath, releaseRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Install(t.Context(), release.root, release.manifest, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(databasePath); err != nil {
		t.Fatal(err)
	}
	recovered, err := Open(databasePath, releaseRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	status, err := recovered.Install(t.Context(), release.root, release.manifest, time.Now())
	if err != nil || status.Version != "5.0.0" || status.State != "candidate" {
		t.Fatalf("installed directory was not recoverable: %#v %v", status, err)
	}
}

type testRelease struct {
	root     string
	manifest ReleaseManifest
}

func makeTestRelease(t *testing.T, version string, contents map[Component]string) testRelease {
	t.Helper()
	root := t.TempDir()
	components := make([]Component, 0, len(contents))
	artifacts := make([]Artifact, 0, len(contents))
	for component, content := range contents {
		name := filepath.ToSlash(filepath.Join("components", string(component)+".zip"))
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		digest, err := hashFile(path)
		if err != nil {
			t.Fatal(err)
		}
		components = append(components, component)
		artifacts = append(artifacts, Artifact{Component: component, File: name, Size: int64(len(content)), SHA256: digest})
	}
	components = sortedComponents(components)
	return testRelease{root: root, manifest: ReleaseManifest{FormatVersion: 1, Version: version, IncludedComponents: components, Artifacts: artifacts}}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	root := t.TempDir()
	store, err := Open(filepath.Join(root, "operations.db"), filepath.Join(root, "releases"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func passingReadiness(checkedAt time.Time) Readiness {
	return Readiness{
		CheckedAt:       checkedAt,
		Harness:         Probe{OK: true, Evidence: "harness-request-ok"},
		Codex:           Probe{OK: true, Evidence: "codex-request-ok"},
		Kimi:            Probe{OK: true, Evidence: "kimi-request-ok"},
		ManagedProvider: Probe{OK: true, Evidence: "managed-provider-request-ok"},
	}
}
