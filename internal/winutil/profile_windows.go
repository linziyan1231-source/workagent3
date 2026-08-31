//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var createProfile = windows.NewLazySystemDLL("userenv.dll").NewProc("CreateProfile")

const hresultProfileAlreadyExists = 0x800700b7

func EnsureProfileForAccount(sidText, username string, _ []byte) error {
	sid, err := windows.StringToSid(sidText)
	if err != nil || sid == nil || !sid.IsValid() {
		return errors.New("invalid profile SID")
	}
	sidPointer, err := windows.UTF16PtrFromString(sidText)
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return err
	}
	// CreateProfile is an older shell API whose RPC stub rejects output
	// buffers larger than MAX_PATH even when the host has long paths enabled.
	profilePath := make([]uint16, windows.MAX_PATH)
	hresult, _, _ := createProfile.Call(
		uintptr(unsafe.Pointer(sidPointer)), uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(&profilePath[0])), uintptr(len(profilePath)),
	)
	if uint32(hresult) == hresultProfileAlreadyExists {
		return nil
	}
	if hresult != 0 {
		return fmt.Errorf("create employee profile: HRESULT 0x%08x", uint32(hresult))
	}
	path := windows.UTF16ToString(profilePath)
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		return errors.New("Windows profile API did not create the profile directory")
	}
	return nil
}
