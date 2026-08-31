//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"strings"
	"syscall"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	userPrivUser          = 1
	userFlagScript        = 0x0001
	userFlagNormal        = 0x0200
	userFlagNeverExpire   = 0x10000
	userAccountDisabled   = 0x0002
	localGroupsIndirect   = 0x0001
	maxPreferredLength    = 0xffffffff
	nerrUserNotFound      = 2221
	managedAccountComment = "WorkAgent3 managed employee"
)

var netUserAdd = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetUserAdd")
var netUserSetInfo = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetUserSetInfo")
var netUserDel = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetUserDel")
var netUserGetLocalGroups = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetUserGetLocalGroups")

type userInfo1 struct {
	Name, Password         *uint16
	PasswordAge, Privilege uint32
	HomeDir, Comment       *uint16
	Flags                  uint32
	ScriptPath             *uint16
}
type userInfo1003 struct{ Password *uint16 }
type localGroupUsersInfo0 struct{ Name *uint16 }

// EnsureLocalStandardAccount creates a local least-privilege account or
// rotates the password of an existing standard account.
func EnsureLocalStandardAccount(username string, password []byte) (sid, canonical string, err error) {
	if err := ValidateLocalUsername(username); err != nil {
		return "", "", err
	}
	computer, err := windows.ComputerName()
	if err != nil {
		return "", "", err
	}
	exists, accountComment, flags, err := localAccountState(username)
	if err != nil {
		return "", "", err
	}
	if exists {
		if accountComment != managedAccountComment {
			return "", "", errors.New("an unmanaged Windows account already uses this username")
		}
		if flags&userAccountDisabled != 0 {
			return "", "", errors.New("Windows UserHost account is disabled")
		}
		sid, canonical, err = LookupAccount(computer + `\` + username)
		if err != nil {
			return "", "", err
		}
		if admin, err := accountInAdministrators(username); err != nil {
			return "", "", err
		} else if admin {
			return "", "", errors.New("Windows UserHost account belongs to Administrators")
		}
		if err := setLocalPassword(username, password); err != nil {
			return "", "", err
		}
		return sid, canonical, nil
	}
	name, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return "", "", err
	}
	secret, err := passwordUTF16(password)
	if err != nil {
		return "", "", err
	}
	defer zeroUTF16(secret)
	comment, _ := windows.UTF16PtrFromString(managedAccountComment)
	info := userInfo1{Name: name, Password: &secret[0], Privilege: userPrivUser, Comment: comment, Flags: userFlagScript | userFlagNormal | userFlagNeverExpire}
	var parameterError uint32
	status, _, _ := netUserAdd.Call(0, 1, uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&parameterError)))
	if status != 0 {
		return "", "", fmt.Errorf("create Windows standard account: Windows error %d (parameter %d)", status, parameterError)
	}
	return LookupAccount(computer + `\` + username)
}

func localAccountState(username string) (exists bool, comment string, flags uint32, err error) {
	pointer, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return false, "", 0, err
	}
	var buffer *byte
	err = windows.NetUserGetInfo(nil, pointer, 1, &buffer)
	if errors.Is(err, syscall.Errno(nerrUserNotFound)) {
		return false, "", 0, nil
	}
	if err != nil {
		return false, "", 0, fmt.Errorf("inspect Windows account: %w", err)
	}
	defer windows.NetApiBufferFree(buffer)
	info := (*userInfo1)(unsafe.Pointer(buffer))
	if info.Comment != nil {
		comment = windows.UTF16PtrToString(info.Comment)
	}
	return true, comment, info.Flags, nil
}

func setLocalPassword(username string, password []byte) error {
	name, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return err
	}
	secret, err := passwordUTF16(password)
	if err != nil {
		return err
	}
	defer zeroUTF16(secret)
	info := userInfo1003{Password: &secret[0]}
	var parameterError uint32
	status, _, _ := netUserSetInfo.Call(0, uintptr(unsafe.Pointer(name)), 1003, uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&parameterError)))
	if status != 0 {
		return fmt.Errorf("rotate Windows account password: Windows error %d (parameter %d)", status, parameterError)
	}
	return nil
}

func DeleteManagedLocalAccount(username, expectedSID string) error {
	if err := ValidateLocalUsername(username); err != nil {
		return err
	}
	exists, comment, _, err := localAccountState(username)
	if err != nil || !exists {
		return err
	}
	if comment != managedAccountComment {
		return errors.New("refusing to delete unmanaged Windows account")
	}
	sid, _, err := LookupAccount(`.\` + username)
	if err != nil {
		return err
	}
	if !strings.EqualFold(sid, expectedSID) {
		return errors.New("refusing to delete Windows account with unexpected SID")
	}
	name, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return err
	}
	status, _, _ := netUserDel.Call(0, uintptr(unsafe.Pointer(name)))
	if status != 0 && status != nerrUserNotFound {
		return fmt.Errorf("delete managed Windows account: Windows error %d", status)
	}
	return nil
}

func accountInAdministrators(username string) (bool, error) {
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return false, err
	}
	adminName, _, _, err := adminSID.LookupAccount("")
	if err != nil {
		return false, err
	}
	pointer, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return false, err
	}
	var buffer uintptr
	var read, total uint32
	status, _, _ := netUserGetLocalGroups.Call(0, uintptr(unsafe.Pointer(pointer)), 0, localGroupsIndirect, uintptr(unsafe.Pointer(&buffer)), maxPreferredLength, uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)))
	if status != 0 {
		return false, fmt.Errorf("read local groups: Windows error %d", status)
	}
	if buffer != 0 {
		defer windows.NetApiBufferFree((*byte)(unsafe.Pointer(buffer)))
	}
	for _, group := range unsafe.Slice((*localGroupUsersInfo0)(unsafe.Pointer(buffer)), int(read)) {
		if group.Name != nil && strings.EqualFold(windows.UTF16PtrToString(group.Name), adminName) {
			return true, nil
		}
	}
	return false, nil
}

func passwordUTF16(password []byte) ([]uint16, error) {
	if len(password) == 0 || !utf8.Valid(password) {
		return nil, errors.New("Windows password must be non-empty valid UTF-8")
	}
	result := make([]uint16, 0, len(password)+1)
	for len(password) > 0 {
		r, size := utf8.DecodeRune(password)
		if r == 0 {
			zeroUTF16(result)
			return nil, errors.New("Windows password contains NUL")
		}
		if r <= 0xffff {
			result = append(result, uint16(r))
		} else {
			first, second := utf16.EncodeRune(r)
			result = append(result, uint16(first), uint16(second))
		}
		password = password[size:]
	}
	return append(result, 0), nil
}
func zeroUTF16(value []uint16) {
	for index := range value {
		value[index] = 0
	}
}
