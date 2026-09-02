//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

var ErrAlreadyRunning = errors.New("employee Harness is already running")

type InstanceLock struct {
	handle windows.Handle
}

// deletePendingRetries bounds the brief wait for a delete-pending lock file:
// the previous instance has already closed its handle and the file is being
// removed, so the lock is effectively free within milliseconds.
const deletePendingRetries = 20

// AcquireInstanceLock takes the cross-session single-instance lock for one
// employee runtime. A named mutex cannot do this job: Local\ objects are
// per-session (the scheduled-task batch session and an interactive logon each
// have their own Local namespace, so the same SID could double-start), and
// Global\ creation requires SeCreateGlobalPrivilege, which the standard
// employee accounts do not hold. A lock file opened with sharing denied in
// the owning user's private Temp directory is visible to every session of
// that user, needs no extra privilege, and cannot be pre-created by other
// users (they have no write access there), so a low-privilege session cannot
// use it to block a legitimate start. FILE_FLAG_DELETE_ON_CLOSE makes the
// lock crash-safe: the file disappears with the last handle instead of going
// stale and blocking the next start.
func AcquireInstanceLock(name string) (*InstanceLock, error) {
	if !validInstanceLockName(name) {
		return nil, errors.New("instance lock name is invalid")
	}
	path, err := windows.UTF16PtrFromString(filepath.Join(os.TempDir(), name+".lock"))
	if err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		handle, err := windows.CreateFile(path, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil,
			windows.OPEN_ALWAYS, windows.FILE_FLAG_DELETE_ON_CLOSE, 0)
		if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
			return nil, ErrAlreadyRunning
		}
		if errors.Is(err, windows.ERROR_DELETE_PENDING) && attempt < deletePendingRetries {
			// The previous holder just exited; its delete-on-close is finishing.
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("create employee runtime lock: %w", err)
		}
		return &InstanceLock{handle: handle}, nil
	}
}

func validInstanceLockName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	return strings.IndexFunc(name, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.')
	}) == -1
}

func (l *InstanceLock) Close() error {
	return windows.CloseHandle(l.handle)
}
