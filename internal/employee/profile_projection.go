package employee

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ProjectHarnessProfile selects shared software without copying dependencies.
// The caller must stop the runtime first. Legacy package trees require the
// audited migration script; provisioning never deletes an unidentified tree.
func ProjectHarnessProfile(source, destination string) error {
	source, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	// Provisioning runs as SYSTEM: never follow employee-controlled directory
	// links or a linked configuration file while writing the private projection.
	for path := destination; ; path = filepath.Dir(path) {
		info, err := os.Lstat(path)
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("private profile ancestor is a link: %s", path)
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if filepath.Dir(path) == path {
			break
		}
	}
	for _, path := range []string{source, filepath.Join(source, "node_modules")} {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("released software must be a normal directory: %s", path)
		}
	}
	manifest, err := os.ReadFile(filepath.Join(source, "package.json"))
	if err != nil {
		return err
	}
	if !json.Valid(manifest) {
		return errors.New("invalid released profile manifest")
	}
	if err := os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(destination)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("profile configuration must be a private normal directory")
	}
	modules := filepath.Join(destination, "node_modules")
	oldTarget, err := os.Readlink(modules)
	if err != nil {
		if _, statErr := os.Lstat(modules); !errors.Is(statErr, os.ErrNotExist) {
			return errors.New("legacy or personal node_modules requires audited software migration before activation")
		}
	}
	// Do not overwrite a locally extended package manifest during an upgrade.
	manifestPath := filepath.Join(destination, "package.json")
	if info, err := os.Lstat(manifestPath); err == nil && !info.Mode().IsRegular() {
		return errors.New("private profile manifest must be a normal file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if current, err := os.ReadFile(manifestPath); err == nil && !bytes.Equal(current, manifest) {
		previous, readErr := os.ReadFile(filepath.Join(filepath.Dir(oldTarget), "package.json"))
		if readErr != nil || !bytes.Equal(current, previous) {
			return errors.New("private profile manifest differs from its release; preserve and reconcile personal plugins before activation")
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// These are configuration, not software. Never replace the employee patch.
	patchPath := filepath.Join(destination, "cordis.patch.yml")
	if _, err := os.Lstat(patchPath); errors.Is(err, os.ErrNotExist) {
		patch, err := os.ReadFile(filepath.Join(source, "cordis.patch.yml"))
		if err != nil {
			return err
		}
		if err := os.WriteFile(patchPath, patch, 0600); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	target := filepath.Join(source, "node_modules")
	if oldTarget != target {
		staging, err := os.MkdirTemp(destination, ".reference-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(staging)
		link := filepath.Join(staging, "node_modules")
		if err := os.Symlink(target, link); err != nil {
			return fmt.Errorf("create shared package reference: %w", err)
		}
		if oldTarget != "" {
			if err := os.Rename(modules, filepath.Join(staging, "previous")); err != nil {
				return err
			}
		}
		if err := os.Rename(link, modules); err != nil {
			if oldTarget != "" {
				_ = os.Rename(filepath.Join(staging, "previous"), modules)
			}
			return err
		}
	}
	return os.WriteFile(manifestPath, manifest, 0600)
}

func projectHarnessProfile(source, destination string) error {
	return ProjectHarnessProfile(source, destination)
}
