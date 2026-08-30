//go:build !windows

package skillruntime

import "io/fs"

func isReparsePoint(fs.FileInfo) bool { return false }
