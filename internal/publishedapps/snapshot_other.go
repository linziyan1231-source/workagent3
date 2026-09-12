//go:build !windows

package publishedapps

import (
	"errors"
	"io"
	"os"
)

func openSnapshotPath(path string, directory bool) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.IsDir() != directory {
		return nil, errors.New("snapshot cannot follow links")
	}
	return os.Open(path)
}
func lockSnapshotPath(path string, directory bool) (io.Closer, error) {
	return openSnapshotPath(path, directory)
}
func openSnapshotFile(path string) (*os.File, error) { return openSnapshotPath(path, false) }
