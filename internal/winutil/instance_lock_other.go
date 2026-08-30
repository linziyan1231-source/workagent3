//go:build !windows

package winutil

import "errors"

var ErrAlreadyRunning = errors.New("employee Harness is already running")

type InstanceLock struct{}

func AcquireInstanceLock(_ string) (*InstanceLock, error) {
	return nil, errors.New("employee runtime lock is only available on Windows")
}

func (l *InstanceLock) Close() error { return nil }
