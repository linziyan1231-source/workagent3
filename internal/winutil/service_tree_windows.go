//go:build windows

package winutil

import (
	"golang.org/x/sys/windows"
	"os"
)

// EnsureServiceTree grants employees read/execute only when requested. The
// private vault uses SYSTEM's user-scoped DPAPI in addition to this DACL.
func EnsureServiceTree(root string, readable bool) error {
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	if err := rejectSharedReparsePoint(root); err != nil {
		return err
	}
	return protectServicePath(root, readable)
}

func ProtectServiceFile(path string) error { return protectServicePath(path, false) }

func protectServicePath(root string, readable bool) error {
	sddl := "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	if readable {
		sddl += "(A;OICI;GRGX;;;BU)"
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	owner, _, _ := sd.Owner()
	group, _, _ := sd.Group()
	dacl, _, _ := sd.DACL()
	return setNamedSecurityInfoWithOwnerPrivilege(root, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, owner, group, dacl)
}
