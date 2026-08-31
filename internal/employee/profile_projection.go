package employee

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// projectHarnessProfile installs the immutable, release-owned Harness profile
// into a SID-private DSH_HOME. Symlinks are preserved only when they stay
// inside the released profile tree.
func projectHarnessProfile(source, destination string) error {
	source = filepath.Clean(source)
	destination = filepath.Clean(destination)
	info, err := os.Lstat(source)
	if err != nil {
		return fmt.Errorf("inspect Harness profile source: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Harness profile source must be a normal directory")
	}
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fmt.Errorf("create private Harness profile parent: %w", err)
	}
	staging, err := os.MkdirTemp(parent, ".profile-staging-")
	if err != nil {
		return fmt.Errorf("create Harness profile staging directory: %w", err)
	}
	defer os.RemoveAll(staging)
	if err := copyProfileTree(source, staging); err != nil {
		return err
	}
	backup := destination + ".previous"
	if err := os.RemoveAll(backup); err != nil {
		return fmt.Errorf("remove stale Harness profile backup: %w", err)
	}
	_, destinationErr := os.Lstat(destination)
	hadDestination := destinationErr == nil
	if destinationErr != nil && !errors.Is(destinationErr, os.ErrNotExist) {
		return fmt.Errorf("inspect previous Harness profile: %w", destinationErr)
	}
	if hadDestination {
		if err := os.Rename(destination, backup); err != nil {
			return fmt.Errorf("retain previous Harness profile: %w", err)
		}
	}
	if err := os.Rename(staging, destination); err != nil {
		if hadDestination {
			_ = os.Rename(backup, destination)
		}
		return fmt.Errorf("activate Harness profile: %w", err)
	}
	if hadDestination {
		if err := os.RemoveAll(backup); err != nil {
			return fmt.Errorf("remove previous Harness profile: %w", err)
		}
	}
	return nil
}

func copyProfileTree(source, destination string) error {
	type profileLink struct{ relative, target string }
	var links []profileLink
	err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		target := filepath.Join(destination, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := validateProfileLink(source, path, link); err != nil {
				return err
			}
			links = append(links, profileLink{relative: relative, target: link})
			return nil
		}
		if entry.IsDir() {
			if err := os.Mkdir(target, info.Mode().Perm()); err != nil {
				return fmt.Errorf("copy Harness profile directory %s: %w", relative, err)
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("Harness profile contains unsupported file %s", relative)
		}
		if err := copyProfileFile(path, target, info.Mode().Perm()); err != nil {
			return fmt.Errorf("copy Harness profile file %s: %w", relative, err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Windows decides whether a symlink targets a file or directory when the
	// link is created. Create links only after every target has been copied.
	for _, link := range links {
		if err := os.Symlink(link.target, filepath.Join(destination, link.relative)); err != nil {
			return fmt.Errorf("copy Harness profile symlink %s: %w", link.relative, err)
		}
	}
	return nil
}

func validateProfileLink(source, path, link string) error {
	if filepath.IsAbs(link) {
		return fmt.Errorf("Harness profile symlink %s has an absolute target", path)
	}
	resolved := filepath.Clean(filepath.Join(filepath.Dir(path), link))
	relative, err := filepath.Rel(source, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("Harness profile symlink %s escapes the profile root", path)
	}
	return nil
}

func copyProfileFile(source, destination string, mode fs.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	if err := output.Sync(); err != nil {
		output.Close()
		return err
	}
	return output.Close()
}
