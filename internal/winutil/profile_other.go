//go:build !windows

package winutil

import "errors"

func EnsureProfileForAccount(string, string, []byte) error {
	return errors.New("Windows profile provisioning is only available on Windows")
}
