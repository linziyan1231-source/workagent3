//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var restorePrivilegeMu sync.Mutex

func setNamedSecurityInfoWithOwnerPrivilege(path string, security windows.SECURITY_INFORMATION, owner, group *windows.SID, dacl *windows.ACL) error {
	err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, security, owner, group, dacl, nil)
	if !errors.Is(err, windows.ERROR_INVALID_OWNER) {
		return err
	}

	restorePrivilegeMu.Lock()
	defer restorePrivilegeMu.Unlock()

	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		return fmt.Errorf("open process token for SeRestorePrivilege: %w", err)
	}
	defer token.Close()

	name, err := windows.UTF16PtrFromString("SeRestorePrivilege")
	if err != nil {
		return err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, name, &luid); err != nil {
		return fmt.Errorf("look up SeRestorePrivilege: %w", err)
	}
	desired := windows.Tokenprivileges{PrivilegeCount: 1, Privileges: [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}}}
	var previous windows.Tokenprivileges
	var previousLength uint32
	if err := windows.AdjustTokenPrivileges(token, false, &desired, uint32(unsafe.Sizeof(previous)), &previous, &previousLength); err != nil {
		return fmt.Errorf("enable SeRestorePrivilege: %w", err)
	}
	if err := windows.GetLastError(); errors.Is(err, windows.ERROR_NOT_ALL_ASSIGNED) {
		return errors.New("enable SeRestorePrivilege: privilege is not assigned to the process token")
	}
	defer windows.AdjustTokenPrivileges(token, false, &previous, 0, nil, nil)

	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, security, owner, group, dacl, nil)
}
