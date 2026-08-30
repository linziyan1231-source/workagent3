//go:build windows

package employee

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteAtomicReplacesProvisionedRuntimeFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.token")
	if err := writeAtomic(path, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(path, []byte("second")); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(path)
	if err != nil || string(payload) != "second" {
		t.Fatalf("replacement payload=%q err=%v", payload, err)
	}
}

func TestTaskPowerShellEnvironmentDoesNotInheritServiceSecrets(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "must-not-leak")
	environment := strings.Join(restrictedEnvironment(map[string]string{"WA3_TASK": "WorkAgent3-test"}), "\n")
	if strings.Contains(environment, "must-not-leak") {
		t.Fatal("service credential leaked into Task Scheduler helper")
	}
	if !strings.Contains(environment, "WA3_TASK=WorkAgent3-test") {
		t.Fatal("task input missing")
	}
}
