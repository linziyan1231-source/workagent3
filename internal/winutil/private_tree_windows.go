//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// EnsurePrivateTree creates a non-reparse SID-private root whose inheritable
// ACL grants access only to SYSTEM, Administrators, and the employee.
func EnsurePrivateTree(root, userSID string) error {
	if !filepath.IsAbs(root) {
		return errors.New("private data root must be absolute")
	}
	user, err := windows.StringToSid(userSID)
	if err != nil || user == nil || !user.IsValid() {
		return errors.New("invalid employee SID")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("private data root is not a normal directory")
	}
	if attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(root)); err != nil {
		return err
	} else if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("private data root must not be a reparse point")
	}
	desired, err := privateTreeDescriptor(userSID)
	if err != nil {
		return err
	}
	owner, _, err := desired.Owner()
	if err != nil {
		return err
	}
	dacl, _, err := desired.DACL()
	if err != nil {
		return err
	}
	group, _, err := desired.Group()
	if err != nil {
		return err
	}
	security := windows.SECURITY_INFORMATION(windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION)
	if err := windows.SetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, security, owner, group, dacl, nil); err != nil {
		return fmt.Errorf("protect private data root: %w", err)
	}
	actual, err := windows.GetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("verify private data root: %w", err)
	}
	actualSDDL := strings.Replace(actual.String(), "D:PAI", "D:P", 1)
	if !strings.EqualFold(actualSDDL, desired.String()) {
		return fmt.Errorf("private data root ACL verification failed: got %s", actual.String())
	}
	return nil
}

func privateTreeDescriptor(userSID string) (*windows.SECURITY_DESCRIPTOR, error) {
	return windows.SecurityDescriptorFromString("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + userSID + ")")
}
