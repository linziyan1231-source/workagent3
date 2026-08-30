package main

import (
	"os"
	"path/filepath"
	"testing"

	"workagent3/internal/userhost"
)

func TestLoadConfigRejectsRelativePrivatePathsAndUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "userhost.json")
	if err := os.WriteFile(path, []byte(`{"sid":"S-1-5-21-1000","dataRoot":"relative","harnessCommand":"relative","profile":"workagent","portalUrl":"http://127.0.0.1:8080","registrationCredentialFile":"relative","limits":{},"extra":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := userhost.LoadFileConfig(path); err == nil {
		t.Fatal("invalid configuration was accepted")
	}
}

func TestLoadConfigAcceptsProvisionedShape(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "userhost.json")
	payload := `{"sid":"S-1-5-21-1000","dataRoot":"C:\\\\WorkAgent\\\\S-1-5-21-1000","harnessCommand":"C:\\\\WorkAgent\\\\bin\\\\dsh.exe","profile":"workagent","portalUrl":"http://127.0.0.1:8080","registrationCredentialFile":"C:\\\\WorkAgent\\\\S-1-5-21-1000\\\\runtime-registration.token","limits":{"MemoryBytes":1073741824,"CPUPercent":80,"ActiveProcesses":32}}`
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := userhost.LoadFileConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.SID != "S-1-5-21-1000" || config.Limits.ActiveProcesses != 32 {
		t.Fatalf("unexpected config: %+v", config)
	}
}
