//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	sharedSystemSID                             = "S-1-5-18"
	sharedAdministratorsSID                     = "S-1-5-32-544"
	sharedOwnerRightsSID                        = "S-1-3-4"
	sharedModifyMask                            = "0x001301bf"
	sharedTraverseMask      windows.ACCESS_MASK = windows.FILE_TRAVERSE | windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE
)

// EnsureSharedOwnerLayout is called by the privileged employee provisioner.
// It preserves unrelated shared-root ACEs while granting the employee only
// metadata traversal, then creates their protected owner root.
func EnsureSharedOwnerLayout(base, ownerSID string) error {
	if !filepath.IsAbs(base) || validateCanonicalSID(ownerSID) != nil {
		return errors.New("shared owner layout requires an absolute base and valid SID")
	}
	sharedRoot := filepath.Join(base, "shared")
	ownerRoot := filepath.Join(sharedRoot, ownerSID)
	if err := os.MkdirAll(ownerRoot, 0o700); err != nil {
		return err
	}
	if err := setExactSharedRootTraverse(sharedRoot, ownerSID); err != nil {
		return err
	}
	return ApplySharedOwnerRoot(ownerRoot, ownerSID, nil)
}

func setExactSharedRootTraverse(path, sidText string) error {
	if err := rejectSharedReparsePoint(path); err != nil {
		return err
	}
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil {
		return errors.New("shared root DACL is missing")
	}
	sid, _ := windows.StringToSid(sidText)
	updated, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{AccessPermissions: sharedTraverseMask, AccessMode: windows.SET_ACCESS, Inheritance: windows.NO_INHERITANCE, Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeType: windows.TRUSTEE_IS_USER, TrusteeValue: windows.TrusteeValueFromSID(sid)}}}, dacl)
	if err != nil {
		return err
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, updated, nil); err != nil {
		return err
	}
	actual, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	actualDACL, _, err := actual.DACL()
	if err != nil || actualDACL == nil {
		return errors.New("shared root DACL is missing after update")
	}
	header := (*sharedACLHeader)(unsafe.Pointer(actualDACL))
	matches := 0
	for index := uint32(0); index < uint32(header.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(actualDACL, index, &ace); err != nil {
			return err
		}
		aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if aceSID != nil && aceSID.IsValid() && strings.EqualFold(aceSID.String(), sidText) {
			matches++
			if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags != 0 || ace.Mask != sharedTraverseMask {
				return errors.New("shared root traversal ACE is not exact")
			}
		}
	}
	if matches != 1 {
		return fmt.Errorf("shared root requires one traversal ACE, found %d", matches)
	}
	return nil
}

type sharedACLHeader struct {
	Revision byte
	Sbz1     byte
	Size     uint16
	AceCount uint16
	Sbz2     uint16
}

// ApplySharedOwnerRoot projects the WorkAgent2 shared-owner-root policy: the
// owner, SYSTEM, and Administrators have full control while members receive
// metadata traversal only. The DACL is protected and verified after writing.
func ApplySharedOwnerRoot(root, ownerSID string, memberSIDs []string) error {
	if err := validateSharedACLInput(root, ownerSID, memberSIDs); err != nil {
		return err
	}
	return applyAndVerifySharedACL(root, true, sharedOwnerRootSDDL(ownerSID, memberSIDs))
}

// ApplySharedProjectTree projects the WorkAgent2 shared-project policy onto
// every existing descendant and refuses to cross any reparse point.
func ApplySharedProjectTree(root, ownerSID string, memberSIDs []string) error {
	if err := validateSharedACLInput(root, ownerSID, memberSIDs); err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := rejectSharedReparsePoint(path); err != nil {
			return err
		}
		return applyAndVerifySharedACL(path, entry.IsDir(), sharedProjectSDDL(ownerSID, memberSIDs, entry.IsDir()))
	})
}

func validateSharedACLInput(root, ownerSID string, memberSIDs []string) error {
	if !filepath.IsAbs(root) {
		return errors.New("shared ACL root must be absolute")
	}
	if err := validateCanonicalSID(ownerSID); err != nil {
		return errors.New("shared ACL owner SID is invalid")
	}
	for _, sid := range memberSIDs {
		if err := validateCanonicalSID(sid); err != nil || strings.EqualFold(sid, ownerSID) || forbiddenSharedACLPrincipal(sid) {
			return errors.New("shared ACL member SID is invalid")
		}
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("shared ACL root must be a normal directory")
	}
	return rejectSharedReparsePoint(root)
}

func validateCanonicalSID(value string) error {
	sid, err := windows.StringToSid(value)
	if err != nil || sid == nil || !sid.IsValid() || !strings.EqualFold(sid.String(), value) {
		return errors.New("invalid SID")
	}
	return nil
}

func forbiddenSharedACLPrincipal(value string) bool {
	for _, sid := range []string{"S-1-1-0", "S-1-5-11", sharedSystemSID, sharedAdministratorsSID, "S-1-5-32-545", sharedOwnerRightsSID} {
		if strings.EqualFold(value, sid) {
			return true
		}
	}
	return false
}

func rejectSharedReparsePoint(path string) error {
	attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(path))
	if err != nil {
		return err
	}
	if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("shared ACL tree contains reparse point: %s", path)
	}
	return nil
}

func sharedOwnerRootSDDL(ownerSID string, memberSIDs []string) string {
	entries := []string{
		"(A;OICI;FA;;;" + sharedSystemSID + ")",
		"(A;OICI;FA;;;" + sharedAdministratorsSID + ")",
		"(A;OICI;FA;;;" + ownerSID + ")",
	}
	for _, sid := range sortedUniqueSIDs(memberSIDs) {
		entries = append(entries, "(A;OICI;0x001000a0;;;"+sid+")")
	}
	return "O:" + ownerSID + "G:" + sharedSystemSID + "D:P" + strings.Join(entries, "")
}

func sharedProjectSDDL(ownerSID string, memberSIDs []string, directory bool) string {
	flags := ""
	if directory {
		flags = "OICI"
	}
	entries := []string{
		"(A;" + flags + ";FA;;;" + sharedSystemSID + ")",
		"(A;" + flags + ";FA;;;" + sharedAdministratorsSID + ")",
		"(A;" + flags + ";FA;;;" + ownerSID + ")",
		"(A;" + flags + ";" + sharedModifyMask + ";;;" + sharedOwnerRightsSID + ")",
	}
	for _, sid := range sortedUniqueSIDs(memberSIDs) {
		entries = append(entries, "(A;"+flags+";"+sharedModifyMask+";;;"+sid+")")
	}
	return "O:" + ownerSID + "G:" + sharedSystemSID + "D:P" + strings.Join(entries, "")
}

func sortedUniqueSIDs(values []string) []string {
	unique := make(map[string]string, len(values))
	for _, value := range values {
		unique[strings.ToUpper(value)] = value
	}
	keys := make([]string, 0, len(unique))
	for key := range unique {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, unique[key])
	}
	return result
}

func applyAndVerifySharedACL(path string, directory bool, sddl string) error {
	if err := rejectSharedReparsePoint(path); err != nil {
		return err
	}
	desired, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("build shared ACL: %w", err)
	}
	owner, _, err := desired.Owner()
	if err != nil {
		return err
	}
	group, _, err := desired.Group()
	if err != nil {
		return err
	}
	dacl, _, err := desired.DACL()
	if err != nil {
		return err
	}
	security := windows.SECURITY_INFORMATION(windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION)
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, security, owner, group, dacl, nil); err != nil {
		return fmt.Errorf("set protected shared ACL: %w", err)
	}
	actual, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("verify protected shared ACL: %w", err)
	}
	actualSDDL := strings.Replace(actual.String(), "D:PAI", "D:P", 1)
	if !strings.EqualFold(actualSDDL, desired.String()) {
		kind := "file"
		if directory {
			kind = "directory"
		}
		return fmt.Errorf("shared %s ACL verification failed: got %s", kind, actual.String())
	}
	return nil
}
