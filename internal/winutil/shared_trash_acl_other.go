//go:build !windows

package winutil

import (
	"os"
	"path/filepath"
)

func ProtectSharedTrashRoot(root string) error { return os.Chmod(root, 0700) }

func SharedTrashFileHasMultipleLinks(string) (bool, error) { return false, nil }

func ProtectSharedTrashTree(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		mode := os.FileMode(0600)
		if entry.IsDir() {
			mode = 0700
		}
		return os.Chmod(path, mode)
	})
}

func RestoreSharedTrashTree(root, projectRoot string) error {
	info, err := os.Stat(projectRoot)
	if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		mode := info.Mode().Perm()
		if !entry.IsDir() {
			mode &= 0666
		}
		return os.Chmod(path, mode)
	})
}
