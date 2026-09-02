package employee

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// compressTaskTiming shortens the poll interval and confirm timeouts for
// tests and restores them afterwards.
func compressTaskTiming(t *testing.T) {
	t.Helper()
	interval, stopTimeout, startTimeout := taskStatePollInterval, taskStopConfirmTimeout, taskStartConfirmTimeout
	taskStatePollInterval, taskStopConfirmTimeout, taskStartConfirmTimeout = time.Millisecond, 200*time.Millisecond, 200*time.Millisecond
	t.Cleanup(func() {
		taskStatePollInterval, taskStopConfirmTimeout, taskStartConfirmTimeout = interval, stopTimeout, startTimeout
	})
}

type fakeTaskState struct {
	sequence []string
	calls    int
}

func (f *fakeTaskState) state(context.Context, string) (string, error) {
	f.calls++
	if f.calls <= len(f.sequence) {
		return f.sequence[f.calls-1], nil
	}
	return f.sequence[len(f.sequence)-1], nil
}

func TestStartScheduledTaskWaitsForStoppingInstance(t *testing.T) {
	compressTaskTiming(t)
	// A previous instance is still stopping (Running twice), then the task is
	// Ready; the start flips it back to Running.
	states := &fakeTaskState{sequence: []string{"Running", "Running", "Ready", "Running"}}
	started := 0
	start := func(context.Context, string) error { started++; return nil }
	if err := startScheduledTask(t.Context(), "WorkAgent3-S-1-5-21-1000", start, states.state); err != nil {
		t.Fatal(err)
	}
	if started != 1 {
		t.Fatalf("start called %d times", started)
	}
	if states.calls < 3 {
		t.Fatalf("start issued before the task left the Running state after %d state checks", states.calls)
	}
}

func TestStartScheduledTaskDetectsSwallowedStart(t *testing.T) {
	compressTaskTiming(t)
	// The task is Ready, the start is swallowed (IgnoreNew), and the task never
	// reaches Running: this must surface as an error, not a silent success.
	states := &fakeTaskState{sequence: []string{"Ready"}}
	start := func(context.Context, string) error { return nil }
	err := startScheduledTask(t.Context(), "WorkAgent3-S-1-5-21-1000", start, states.state)
	if err == nil || !strings.Contains(err.Error(), "ignored") {
		t.Fatalf("swallowed start was accepted: %v", err)
	}
}

func TestStartScheduledTaskFailsWhenInstanceNeverStops(t *testing.T) {
	compressTaskTiming(t)
	states := &fakeTaskState{sequence: []string{"Running"}}
	started := false
	start := func(context.Context, string) error { started = true; return nil }
	err := startScheduledTask(t.Context(), "WorkAgent3-S-1-5-21-1000", start, states.state)
	if err == nil || !strings.Contains(err.Error(), "still stopping") {
		t.Fatalf("start over a running instance was accepted: %v", err)
	}
	if started {
		t.Fatal("start was issued while the previous instance was still running")
	}
}

func TestStartScheduledTaskPropagatesStateQueryError(t *testing.T) {
	compressTaskTiming(t)
	state := func(context.Context, string) (string, error) { return "", errors.New("task scheduler unavailable") }
	if err := startScheduledTask(t.Context(), "WorkAgent3-S-1-5-21-1000", func(context.Context, string) error { return nil }, state); err == nil {
		t.Fatal("state query failure was accepted")
	}
}
