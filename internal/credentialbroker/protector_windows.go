//go:build windows

package credentialbroker

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

type userProtector struct {
	entropy []byte
}

// NewUserProtector uses DPAPI's current-user scope, so another Windows SID
// cannot decrypt a credential even if it can obtain the database file.
func NewUserProtector() Protector {
	return &userProtector{entropy: []byte("WorkAgent3-CredentialBroker-v1")}
}

func (p *userProtector) Seal(plain []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, errors.New("credential is empty")
	}
	input := windows.DataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	entropy := windows.DataBlob{Size: uint32(len(p.entropy)), Data: &p.entropy[0]}
	var output windows.DataBlob
	err := windows.CryptProtectData(&input, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	runtime.KeepAlive(plain)
	runtime.KeepAlive(p.entropy)
	if err != nil {
		return nil, fmt.Errorf("DPAPI protect: %w", err)
	}
	return copyAndFree(output)
}

func (p *userProtector) Open(sealed []byte) ([]byte, error) {
	if len(sealed) == 0 {
		return nil, errors.New("credential is revoked")
	}
	input := windows.DataBlob{Size: uint32(len(sealed)), Data: &sealed[0]}
	entropy := windows.DataBlob{Size: uint32(len(p.entropy)), Data: &p.entropy[0]}
	var output windows.DataBlob
	err := windows.CryptUnprotectData(&input, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	runtime.KeepAlive(sealed)
	runtime.KeepAlive(p.entropy)
	if err != nil {
		return nil, fmt.Errorf("DPAPI unprotect: %w", err)
	}
	return copyAndFree(output)
}

func copyAndFree(blob windows.DataBlob) ([]byte, error) {
	if blob.Data == nil {
		return nil, errors.New("DPAPI returned no data")
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(blob.Data)))
	result := append([]byte(nil), unsafe.Slice(blob.Data, int(blob.Size))...)
	return result, nil
}
