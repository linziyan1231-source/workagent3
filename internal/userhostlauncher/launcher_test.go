package userhostlauncher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestReleaseSwitchKeepsEmployeeBinding(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "launch.json")
	m := Manifest{Executable: filepath.Join(root, "release-one", "userhost.exe"), Config: filepath.Join(root, "employee", "userhost.json"), SID: "S-1-5-21-1001"}
	save := func() {
		b, _ := json.Marshal(m)
		if err := os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	save()
	if _, err := Load(path, "S-1-5-21-1002"); err == nil {
		t.Fatal("cross employee launch accepted")
	}
	m.Executable = filepath.Join(root, "release-two", "userhost.exe")
	save()
	got, err := Load(path, m.SID)
	if err != nil || got.Executable != m.Executable {
		t.Fatal("release switch not loaded")
	}
	m.Executable = "relative.exe"
	save()
	if _, err := Load(path, m.SID); err == nil {
		t.Fatal("relative executable accepted")
	}
}
