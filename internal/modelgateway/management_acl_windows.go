//go:build windows

package modelgateway

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"

	"workagent3/internal/winutil"
)

const (
	localSystemSID    = "S-1-5-18"
	administratorsSID = "S-1-5-32-544"
)

// verifyManagementKeyFileACL reads the key file DACL and requires that every
// allow ACE names only the current (Employee Manager) account, SYSTEM, or the
// local Administrators group. Deny ACEs cannot widen access and are ignored.
func verifyManagementKeyFileACL(path string) error {
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read CLIProxyAPI management key file ACL: %w", err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil {
		return errors.New("CLIProxyAPI management key file has no DACL")
	}
	current, err := winutil.CurrentSID()
	if err != nil {
		return err
	}
	header := (*aclHeader)(unsafe.Pointer(dacl))
	principals := make([]string, 0, header.AceCount)
	for index := uint32(0); index < uint32(header.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil {
			return fmt.Errorf("read CLIProxyAPI management key file ACE: %w", err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if sid == nil || !sid.IsValid() {
			return errors.New("CLIProxyAPI management key file ACL contains an invalid SID")
		}
		principals = append(principals, sid.String())
	}
	return managementKeyACLCheck(principals, []string{current, localSystemSID, administratorsSID})
}

type aclHeader struct {
	Revision byte
	Sbz1     byte
	Size     uint16
	AceCount uint16
	Sbz2     uint16
}
