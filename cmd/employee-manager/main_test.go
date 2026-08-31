package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadManagerConfigRejectsRelativeOrUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manager.json")
	if err := os.WriteFile(path, []byte(`{"databasePath":"relative.db","dataRootBase":"relative","userHostExecutable":"relative","harnessCommand":"relative","profile":"workagent","portalUrl":"http://127.0.0.1:8080","limits":{},"unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadManagerConfig(path); err == nil {
		t.Fatal("unsafe manager configuration was accepted")
	}
}

func TestBytesTrimLineEndingPreservesPasswordContent(t *testing.T) {
	value := bytesTrimLineEnding([]byte("correct horse battery staple\r\n"))
	if string(value) != "correct horse battery staple" {
		t.Fatalf("unexpected password %q", value)
	}
}
