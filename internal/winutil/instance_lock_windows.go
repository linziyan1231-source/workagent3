//go:build windows

package winutil

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

var ErrAlreadyRunning = errors.New("employee Harness is already running")

type InstanceLock struct {
	handle windows.Handle
}

func AcquireInstanceLock(name string) (*InstanceLock, error) {
	namePointer, err := windows.UTF16PtrFromString(`Local\` + name)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateMutex(nil, false, namePointer)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(handle)
		return nil, ErrAlreadyRunning
	}
	if err != nil {
		return nil, fmt.Errorf("create employee runtime mutex: %w", err)
	}
	return &InstanceLock{handle: handle}, nil
}

func (l *InstanceLock) Close() error {
	return windows.CloseHandle(l.handle)
}
