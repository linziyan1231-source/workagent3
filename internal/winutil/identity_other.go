//go:build !windows

package winutil

import "errors"

func CurrentSID() (string, error) { return "", errors.New("Windows SID is only available on Windows") }
func RequireSID(_ string) error   { return errors.New("Windows SID is only available on Windows") }
