//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"runtime"
	"unsafe"
)

var logonUserW = windows.NewLazySystemDLL("advapi32.dll").NewProc("LogonUserW")
var changePasswordW = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetUserChangePassword")

func LogonManagedUser(username string, password []byte) (windows.Token, error) {
	name, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return 0, err
	}
	secret, err := passwordUTF16(password)
	if err != nil {
		return 0, err
	}
	defer zeroUTF16(secret)
	var token windows.Token
	ok, _, callErr := logonUserW.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("."))), uintptr(unsafe.Pointer(&secret[0])), 4, 0, uintptr(unsafe.Pointer(&token)))
	if ok == 0 {
		return 0, fmt.Errorf("employee batch logon: %w", callErr)
	}
	return token, nil
}

func ChangeManagedPassword(username string, old, new []byte) error {
	computer, err := windows.ComputerName()
	if err != nil {
		return err
	}
	before, err := passwordUTF16(old)
	if err != nil {
		return err
	}
	defer zeroUTF16(before)
	after, err := passwordUTF16(new)
	if err != nil {
		return err
	}
	defer zeroUTF16(after)
	status, _, _ := changePasswordW.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(computer))), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(username))), uintptr(unsafe.Pointer(&before[0])), uintptr(unsafe.Pointer(&after[0])))
	if status != 0 {
		return fmt.Errorf("change employee password: Windows error %d", status)
	}
	return nil
}

// WithUserToken confines impersonation to a locked OS thread. The callback
// performs only synchronous DPAPI calls; database/filesystem work stays outside.
func WithUserToken(token windows.Token, operation func() error) error {
	var impersonation windows.Token
	if err := windows.DuplicateTokenEx(token, windows.TOKEN_QUERY|windows.TOKEN_IMPERSONATE, nil, windows.SecurityImpersonation, windows.TokenImpersonation, &impersonation); err != nil {
		return err
	}
	defer impersonation.Close()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.SetThreadToken(nil, impersonation); err != nil {
		return err
	}
	defer func() {
		if err := windows.RevertToSelf(); err != nil {
			panic("cannot revert maintenance impersonation")
		}
	}()
	return operation()
}

func ProcessUserToken(pid uint32, sid string) (windows.Token, error) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_IMPERSONATE, &token); err != nil {
		return 0, err
	}
	user, err := token.GetTokenUser()
	if err != nil {
		token.Close()
		return 0, err
	}
	if user.User.Sid.String() != sid {
		token.Close()
		return 0, errors.New("migration source process belongs to a different SID")
	}
	return token, nil
}
