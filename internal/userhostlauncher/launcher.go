package userhostlauncher

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// Manifest is administrator-owned. Config is also fixed by the administrator,
// so the employee cannot select a different release or another employee's root.
type Manifest struct {
	Executable string `json:"executable"`
	Config     string `json:"config"`
	SID        string `json:"sid"`
}

func Load(path, sid string) (Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err = json.Unmarshal(data, &m); err != nil {
		return m, err
	}
	if m.SID != sid || !filepath.IsAbs(m.Executable) || !filepath.IsAbs(m.Config) {
		return m, errors.New("invalid UserHost launch manifest")
	}
	return m, nil
}
func Run(m Manifest) error {
	command := exec.Command(m.Executable, "--config", m.Config)
	command.Dir = filepath.Dir(m.Executable)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	return command.Run()
}
