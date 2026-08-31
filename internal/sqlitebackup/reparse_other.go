//go:build !windows

package sqlitebackup

import "io/fs"

func isReparsePoint(fs.FileInfo) bool { return false }
