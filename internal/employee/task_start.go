package employee

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Scheduled task start confirmation tuning. These are variables so tests can
// compress them; production uses the conservative defaults.
var (
	taskStatePollInterval   = 250 * time.Millisecond
	taskStopConfirmTimeout  = 30 * time.Second
	taskStartConfirmTimeout = 30 * time.Second
)

// startScheduledTask guarantees that a nil return means the task is truly
// running: Start-ScheduledTask with MultipleInstances IgnoreNew silently
// swallows a start issued while a previous instance is still stopping (the
// stop is asynchronous), which once left an employee runtime down with no
// error surfaced. The start is therefore bracketed by state confirmation —
// first the task must leave the Running state, then after the start it must
// re-enter it. start and state are injectable for tests.
func startScheduledTask(ctx context.Context, name string, start func(context.Context, string) error, state func(context.Context, string) (string, error)) error {
	if err := waitTaskState(ctx, name, state, func(value string) bool { return !strings.EqualFold(value, "Running") },
		taskStopConfirmTimeout, "a stopped state"); err != nil {
		return fmt.Errorf("employee runtime task %s was still stopping: %w", name, err)
	}
	if err := start(ctx, name); err != nil {
		return err
	}
	if err := waitTaskState(ctx, name, state, func(value string) bool { return strings.EqualFold(value, "Running") },
		taskStartConfirmTimeout, "Running"); err != nil {
		return fmt.Errorf("Start-ScheduledTask for %s was ignored (MultipleInstances IgnoreNew) or the runtime exited immediately: %w", name, err)
	}
	return nil
}

func waitTaskState(ctx context.Context, name string, state func(context.Context, string) (string, error), reached func(string) bool, timeout time.Duration, description string) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(taskStatePollInterval)
	defer ticker.Stop()
	for {
		value, err := state(ctx, name)
		if err != nil {
			return err
		}
		if reached(value) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("task did not reach %s before the timeout (last state %q)", description, value)
		case <-ticker.C:
		}
	}
}
