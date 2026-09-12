package userhost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPublishedPythonRequiresAnExplicitAbsoluteInterpreter(t *testing.T) {
	root := t.TempDir()
	base := FileConfig{SID: "S-1-5-21-1000", DataRoot: root, HarnessCommand: filepath.Join(root, "node.exe"), Profile: "workagent", PortalURL: "http://127.0.0.1:8080", RegistrationCredentialFile: filepath.Join(root, "token")}
	for _, command := range []string{"", filepath.Join(root, "public", "python.exe"), "python.exe"} {
		base.PublishedPythonCommand = command
		body, _ := json.Marshal(base)
		path := filepath.Join(root, "userhost.json")
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadFileConfig(path)
		valid := command != "python.exe"
		if (err == nil) != valid || (valid && loaded.PublishedPythonCommand != command) {
			t.Fatalf("interpreter %q: %v", command, err)
		}
		_, err = New(Config{SID: base.SID, DataRoot: root, Command: base.HarnessCommand, Profile: base.Profile, PlatformURL: base.PortalURL, PlatformCredential: "test", PublishedPythonCommand: command})
		if (err == nil) != valid {
			t.Fatalf("supervisor interpreter %q: %v", command, err)
		}
	}
}
