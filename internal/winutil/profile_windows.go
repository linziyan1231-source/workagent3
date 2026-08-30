//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var logonUser = windows.NewLazySystemDLL("advapi32.dll").NewProc("LogonUserW")
var loadUserProfile = windows.NewLazySystemDLL("userenv.dll").NewProc("LoadUserProfileW")
var unloadUserProfile = windows.NewLazySystemDLL("userenv.dll").NewProc("UnloadUserProfile")

type profileInfo struct {
	Size                                                       uint32
	Flags                                                      uint32
	Username, ProfilePath, DefaultPath, ServerName, PolicyPath *uint16
	Profile                                                    windows.Handle
}

func EnsureProfileForAccount(sidText, username string, password []byte) error {
	expected, err := windows.StringToSid(sidText)
	if err != nil || expected == nil || !expected.IsValid() {
		return errors.New("invalid profile SID")
	}
	name, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return err
	}
	domain, _ := windows.UTF16PtrFromString(".")
	secret, err := passwordUTF16(password)
	if err != nil {
		return err
	}
	defer zeroUTF16(secret)
	var token windows.Token
	ok, _, callErr := logonUser.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(domain)), uintptr(unsafe.Pointer(&secret[0])), 4, 0, uintptr(unsafe.Pointer(&token)))
	if ok == 0 {
		return fmt.Errorf("log on employee for profile creation: %w", callErr)
	}
	defer token.Close()
	identity, err := token.GetTokenUser()
	if err != nil || !strings.EqualFold(identity.User.Sid.String(), expected.String()) {
		return errors.New("profile logon resolved to an unexpected SID")
	}
	profile := profileInfo{Size: uint32(unsafe.Sizeof(profileInfo{})), Flags: 1, Username: name}
	ok, _, callErr = loadUserProfile.Call(uintptr(token), uintptr(unsafe.Pointer(&profile)))
	if ok == 0 {
		return fmt.Errorf("load employee profile: %w", callErr)
	}
	if ok, _, callErr = unloadUserProfile.Call(uintptr(token), uintptr(profile.Profile)); ok == 0 {
		return fmt.Errorf("unload employee profile: %w", callErr)
	}
	return nil
}
