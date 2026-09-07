//go:build !windows

package winutil

import "errors"

func EnsureServiceTree(string, bool) error { return errors.New("Windows required") }
func ProtectServiceFile(string) error      { return errors.New("Windows required") }
