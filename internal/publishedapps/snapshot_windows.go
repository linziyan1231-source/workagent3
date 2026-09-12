//go:build windows

package publishedapps

import (
	"errors"
	"golang.org/x/sys/windows"
	"io"
	"os"
)

func openSnapshotPath(path string, directory bool) (*os.File, error) {
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
	if directory {
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
	}
	handle, err := windows.CreateFile(windows.StringToUTF16Ptr(path), windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return nil, err
	}
	var information windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &information); err != nil {
		windows.CloseHandle(handle)
		return nil, err
	}
	if information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
		windows.CloseHandle(handle)
		return nil, errors.New("snapshot cannot follow links or reparse points")
	}
	return os.NewFile(uintptr(handle), path), nil
}
func lockSnapshotPath(path string, directory bool) (io.Closer, error) {
	return openSnapshotPath(path, directory)
}
func openSnapshotFile(path string) (*os.File, error) { return openSnapshotPath(path, false) }
