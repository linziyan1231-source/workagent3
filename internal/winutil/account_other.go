//go:build !windows

package winutil

import "errors"

func EnsureLocalStandardAccount(string, []byte) (string, string, error) {
	return "", "", errors.New("Windows account provisioning is only available on Windows")
}

func DeleteManagedLocalAccount(string, string) error {
	return errors.New("Windows account provisioning is only available on Windows")
}
