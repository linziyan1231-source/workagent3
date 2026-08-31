//go:build windows

package userhost

import "golang.org/x/sys/windows"

func sharedPathIsReparse(path string) bool {
	attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(path))
	return err == nil && attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}
