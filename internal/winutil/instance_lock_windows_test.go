//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func lockName() string {
	return fmt.Sprintf("WorkAgent3-Test-%d-%d", os.Getpid(), time.Now().UnixNano())
}

func TestInstanceLockRejectsSecondHarness(t *testing.T) {
	name := lockName()
	first, err := AcquireInstanceLock(name)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := AcquireInstanceLock(name); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second lock error = %v", err)
	}
}

func TestInstanceLockIsReacquirableAfterClose(t *testing.T) {
	name := lockName()
	first, err := AcquireInstanceLock(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := AcquireInstanceLock(name)
	if err != nil {
		t.Fatalf("lock not reacquirable after close: %v", err)
	}
	defer second.Close()
}

func TestInstanceLockIgnoresStaleFileFromCrashedHolder(t *testing.T) {
	// A crashed holder leaves no open handle; an orphaned file (e.g. a copy or
	// an interrupted delete-on-close) must not block the next start.
	name := lockName()
	path := filepath.Join(os.TempDir(), name+".lock")
	stale, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stale.WriteString("pid=1"); err != nil {
		t.Fatal(err)
	}
	if err := stale.Close(); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	lock, err := AcquireInstanceLock(name)
	if err != nil {
		t.Fatalf("stale lock file blocked acquisition: %v", err)
	}
	defer lock.Close()
}

func TestInstanceLockRejectsUnsafeNames(t *testing.T) {
	// Names are pinned to [A-Za-z0-9._-] and gain a ".lock" suffix, so
	// separator/drive traversal is impossible; ".." alone degrades to the
	// harmless filename "...lock".
	for _, name := range []string{"", `a\b`, "a/b", "a:b", "..\\..\\evil"} {
		if _, err := AcquireInstanceLock(name); err == nil {
			t.Fatalf("unsafe lock name %q was accepted", name)
		}
	}
}
