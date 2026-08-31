//go:build !windows

package winutil

import "errors"

func EnsureSharedOwnerLayout(string, string) error {
	return errors.New("shared-project ACLs require Windows")
}

func ApplySharedOwnerRoot(string, string, []string) error {
	return errors.New("shared-project ACLs require Windows")
}

func ApplySharedProjectTree(string, string, []string) error {
	return errors.New("shared-project ACLs require Windows")
}
