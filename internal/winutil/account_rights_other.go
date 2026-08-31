//go:build !windows

package winutil

import "errors"

func EnsureBatchLogonRight(string) error {
	return errors.New("Windows account rights are only available on Windows")
}
