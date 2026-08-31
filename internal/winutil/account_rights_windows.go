//go:build windows

package winutil

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	policyCreateAccount = 0x00000010
	policyLookupNames   = 0x00000800
	batchLogonRight     = "SeBatchLogonRight"
)

var lsaOpenPolicy = windows.NewLazySystemDLL("advapi32.dll").NewProc("LsaOpenPolicy")
var lsaAddAccountRights = windows.NewLazySystemDLL("advapi32.dll").NewProc("LsaAddAccountRights")
var lsaRemoveAccountRights = windows.NewLazySystemDLL("advapi32.dll").NewProc("LsaRemoveAccountRights")
var lsaClose = windows.NewLazySystemDLL("advapi32.dll").NewProc("LsaClose")
var lsaNtStatusToWinError = windows.NewLazySystemDLL("advapi32.dll").NewProc("LsaNtStatusToWinError")

type lsaObjectAttributes struct {
	Length                   uint32
	RootDirectory            uintptr
	ObjectName               uintptr
	Attributes               uint32
	SecurityDescriptor       uintptr
	SecurityQualityOfService uintptr
}

type lsaUnicodeString struct {
	Length, MaximumLength uint16
	Buffer                *uint16
}

func EnsureBatchLogonRight(sid string) error {
	return updateBatchLogonRight(sid, true)
}

func RemoveBatchLogonRight(sid string) error {
	return updateBatchLogonRight(sid, false)
}

func updateBatchLogonRight(sid string, add bool) error {
	accountSID, err := windows.StringToSid(sid)
	if err != nil {
		return fmt.Errorf("parse Windows account SID: %w", err)
	}
	attributes := lsaObjectAttributes{Length: uint32(unsafe.Sizeof(lsaObjectAttributes{}))}
	var policy uintptr
	status, _, _ := lsaOpenPolicy.Call(0, uintptr(unsafe.Pointer(&attributes)), policyLookupNames|policyCreateAccount, uintptr(unsafe.Pointer(&policy)))
	if status != 0 {
		return lsaStatusError("open local security policy", status)
	}
	defer lsaClose.Call(policy)
	rightBuffer, err := windows.UTF16FromString(batchLogonRight)
	if err != nil {
		return err
	}
	right := lsaUnicodeString{
		Length:        uint16((len(rightBuffer) - 1) * 2),
		MaximumLength: uint16(len(rightBuffer) * 2),
		Buffer:        &rightBuffer[0],
	}
	if add {
		status, _, _ = lsaAddAccountRights.Call(policy, uintptr(unsafe.Pointer(accountSID)), uintptr(unsafe.Pointer(&right)), 1)
	} else {
		status, _, _ = lsaRemoveAccountRights.Call(policy, uintptr(unsafe.Pointer(accountSID)), 0, uintptr(unsafe.Pointer(&right)), 1)
	}
	if status != 0 {
		action := "grant batch logon right"
		if !add {
			action = "remove batch logon right"
		}
		return lsaStatusError(action, status)
	}
	return nil
}

func lsaStatusError(action string, status uintptr) error {
	code, _, _ := lsaNtStatusToWinError.Call(status)
	return fmt.Errorf("%s: Windows error %d", action, code)
}
