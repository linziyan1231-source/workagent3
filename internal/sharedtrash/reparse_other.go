//go:build !windows

package sharedtrash

import (
	"errors"
	"os"
)

func isReparse(string) (bool, error) { return false, nil }

func renameNoReplace(source, target string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		if err := os.Link(source, target); err != nil {
			if errors.Is(err, os.ErrExist) {
				return ErrExists
			}
			return err
		}
		return os.Remove(source)
	}
	// Reserve the destination atomically. Unix rename can replace our empty
	// directory, but refuses one in which a concurrent writer created data.
	if err := os.Mkdir(target, 0700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return ErrExists
		}
		return err
	}
	if err := os.Rename(source, target); err != nil {
		_ = os.Remove(target)
		return err
	}
	return nil
}
