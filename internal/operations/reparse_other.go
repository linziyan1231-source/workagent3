//go:build !windows

package operations

import "io/fs"

func isReparsePoint(fs.FileInfo) bool { return false }
