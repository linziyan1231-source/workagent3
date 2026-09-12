package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"workagent3/internal/buildinfo"
)

func softwareVersion() string {
	if buildinfo.Version != "" && buildinfo.Version != "dev" {
		return buildinfo.Version
	}
	executable, err := os.Executable()
	if err != nil {
		return "development"
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(executable), "software-release.json"))
	if err != nil {
		return "development"
	}
	var release struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &release) != nil || release.Version == "" {
		return "development"
	}
	return release.Version
}
