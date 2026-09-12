//go:build windows

package winutil

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func ProtectSharedTrashRoot(root string) error { return EnsureServiceTree(root, false) }

// ProtectSharedTrashTree removes the protected project ACLs retained by an NTFS
// rename. Restricting the destination parent alone would leave known child paths
// accessible to former members with Windows' usual traverse privilege.
func ProtectSharedTrashTree(root string) error {
	if err := validateSharedTrashTree(root); err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := validateSharedTrashPath(path); err != nil {
			return err
		}
		return ProtectServiceFile(path)
	})
}

// RestoreSharedTrashTree uses the project's current owner and membership DACL,
// so ownership transfers and member removals also apply to restored descendants.
func RestoreSharedTrashTree(root, projectRoot string) error {
	if err := validateSharedTrashTree(root); err != nil {
		return err
	}
	if err := rejectSharedReparsePoint(projectRoot); err != nil {
		return err
	}
	descriptor, err := windows.GetNamedSecurityInfo(projectRoot, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return err
	}
	group, _, err := descriptor.Group()
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := validateSharedTrashPath(path); err != nil {
			return err
		}
		return setNamedSecurityInfoWithOwnerPrivilege(path, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, owner, group, dacl)
	})
}

// Hard links share one security descriptor. Project-local names must not grant
// the trash service permission to change an unrelated name's ACL on the volume.
func SharedTrashFileHasMultipleLinks(path string) (bool, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return false, err
	}
	return info.NumberOfLinks > 1, nil
}

func validateSharedTrashPath(path string) error {
	if err := rejectSharedReparsePoint(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode().IsRegular() {
		multiple, err := SharedTrashFileHasMultipleLinks(path)
		if err != nil {
			return err
		}
		if multiple {
			return errors.New("shared trash refuses multiply linked files")
		}
	}
	return nil
}

func validateSharedTrashTree(root string) error {
	return filepath.WalkDir(root, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return validateSharedTrashPath(path)
	})
}
