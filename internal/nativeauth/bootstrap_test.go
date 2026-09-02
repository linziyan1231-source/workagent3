package nativeauth

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testBundle() Bundle {
	return Bundle{FormatVersion: 1, BaseURL: "http://127.0.0.1:8317/v1", CodexAPIKey: "cpa_abcdefghijklmnopqrstuvwxyz", KimiAPIKey: "cpa_zyxwvutsrqponmlkjihgfedcba", CodexModel: "gpt-5.6-sol", KimiModel: "kimi-k3"}
}

func TestStageApplyAndConsumeNativeBootstrap(t *testing.T) {
	root := t.TempDir()
	if err := Stage(root, testBundle()); err != nil {
		t.Fatal(err)
	}
	bundle, staged, err := Load(root)
	if err != nil || !staged || bundle.CodexAPIKey != testBundle().CodexAPIKey {
		t.Fatalf("staged bundle did not load: staged=%v err=%v", staged, err)
	}
	if err := Apply(root); err != nil {
		t.Fatal(err)
	}
	if !Ready(root) {
		t.Fatal("native credentials were not ready")
	}
	// Apply must not consume the bundle: the Harness broker delivery still
	// needs it, and an incomplete delivery must replay on the next start.
	if _, stillStaged, err := Load(root); err != nil || !stillStaged {
		t.Fatalf("bootstrap was consumed before ordered delivery completed: staged=%v err=%v", stillStaged, err)
	}
	if err := Consume(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "runtime", bootstrapFileName)); !os.IsNotExist(err) {
		t.Fatal("one-time bootstrap was not consumed")
	}
	if _, staged, err := Load(root); err != nil || staged {
		t.Fatal("consumed bootstrap still loads")
	}
	for _, path := range []string{filepath.Join(root, "native", "codex", "auth.json"), filepath.Join(root, "native", "kimi", "config.toml")} {
		payload, err := os.ReadFile(path)
		if err != nil || !strings.Contains(string(payload), "cpa_") {
			t.Fatalf("native credential missing from %s: %v", path, err)
		}
	}
}

func TestLoadAndConsumeWithoutStagedBundle(t *testing.T) {
	root := t.TempDir()
	if _, staged, err := Load(root); err != nil || staged {
		t.Fatal("empty data root reported a staged bundle")
	}
	if err := Consume(root); err != nil {
		t.Fatal(err)
	}
}

func TestRejectsNonLoopbackGateway(t *testing.T) {
	bundle := testBundle()
	bundle.BaseURL = "https://models.example/v1"
	if err := bundle.Validate(); err == nil {
		t.Fatal("non-loopback model gateway was accepted")
	}
}
