//go:build !windows

package winutil

import "errors"

func EnsurePrivateTree(string, string) error {
	return errors.New("Windows private ACL provisioning is only available on Windows")
}
