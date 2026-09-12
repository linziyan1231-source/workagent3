//go:build !windows

package skillruntime

import "os"

func createDirectoryReference(link, target string) error { return os.Symlink(target, link) }
