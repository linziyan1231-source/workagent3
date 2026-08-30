//go:build windows

package winutil

import (
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestInstanceLockRejectsSecondHarness(t *testing.T) {
	name := fmt.Sprintf("WorkAgent3-Test-%d-%d", os.Getpid(), time.Now().UnixNano())
	first, err := AcquireInstanceLock(name)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := AcquireInstanceLock(name); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second lock error = %v", err)
	}
}
