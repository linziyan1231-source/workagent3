package nativeauth

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

var windowsSandboxSection = regexp.MustCompile(`(?m)^\s*\[\s*(?:windows|"windows"|'windows')\s*\]`)
var windowsSandboxSetting = regexp.MustCompile(`(?m)^\s*windows\s*\.\s*sandbox\s*=`)

// EnsureWindowsSandbox configures the restricted-token backend for managed,
// non-administrator employee runtimes. Without a backend Codex downgrades
// workspace-write to read-only and rejects even ordinary shell reads.
// An existing administrator-selected Windows configuration takes precedence.
func EnsureWindowsSandbox(dataRoot string) error {
	path := filepath.Join(dataRoot, "native", "codex", "config.toml")
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil // Model credentials have not been provisioned yet.
	}
	if err != nil {
		return err
	}
	if windowsSandboxSection.Match(content) || windowsSandboxSetting.Match(content) {
		return nil
	}
	if err := writePrivate(path+".before-windows-sandbox", content); err != nil {
		return err
	}
	content = append(content, []byte("\n# Restricted-token sandbox for the employee Windows account.\n[windows]\nsandbox = \"unelevated\"\n")...)
	return writePrivate(path, content)
}
