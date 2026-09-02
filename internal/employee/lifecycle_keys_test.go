package employee

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"

	"workagent3/internal/store"
)

// lifecycleKeys is a fake KeyLifecycle that models the two SID downstream
// gateway keys as a single enabled flag and records the ordered call log.
type lifecycleKeys struct {
	events    *[]string
	enabled   map[string]bool
	setErr    error
	revokeErr error
	sets      int
	revokes   int
}

func newLifecycleKeys(events *[]string, sid string, enabled bool) *lifecycleKeys {
	return &lifecycleKeys{events: events, enabled: map[string]bool{sid: enabled}}
}

func (k *lifecycleKeys) SetKeysEnabled(_ context.Context, sid string, enabled bool) error {
	if k.events != nil {
		*k.events = append(*k.events, fmt.Sprintf("keys:%t", enabled))
	}
	if k.setErr != nil {
		return k.setErr
	}
	k.sets++
	k.enabled[sid] = enabled
	return nil
}

func (k *lifecycleKeys) RevokeKeys(_ context.Context, sid string) error {
	if k.events != nil {
		*k.events = append(*k.events, "keys:revoke")
	}
	if k.revokeErr != nil {
		return k.revokeErr
	}
	k.revokes++
	delete(k.enabled, sid)
	return nil
}

func TestLifecycleDisableDisablesKeysBeforeStoppingRuntime(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	var events []string
	platform := &lifecyclePlatform{events: &events}
	keys := newLifecycleKeys(&events, "S-1-5-21-1000", true)
	result, err := (Lifecycle{Platform: platform, Users: data, Keys: keys}).SetEnabled(t.Context(), "alice", false)
	if err != nil || !result.Disabled {
		t.Fatalf("disable failed: result=%+v err=%v", result, err)
	}
	if keys.enabled["S-1-5-21-1000"] {
		t.Fatal("gateway keys stayed enabled after disable")
	}
	if slices.Index(events, "keys:false") > slices.Index(events, "stop") {
		t.Fatalf("gateway keys were not disabled before the runtime stop: %v", events)
	}
}

func TestLifecycleKeyDisableFailureKeepsRuntimeRunningAndRetries(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{}
	keys := newLifecycleKeys(nil, "S-1-5-21-1000", true)
	keys.setErr = errors.New("gateway unavailable")
	lifecycle := Lifecycle{Platform: platform, Users: data, Keys: keys}
	if _, err := lifecycle.SetEnabled(t.Context(), "alice", false); err == nil {
		t.Fatal("gateway key disable failure was hidden")
	}
	if platform.stops != 0 {
		t.Fatal("runtime was stopped while gateway keys are still enabled")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled {
		t.Fatal("failed key disable reopened the Portal account")
	}
	keys.setErr = nil
	if _, err := lifecycle.SetEnabled(t.Context(), "alice", false); err != nil {
		t.Fatalf("idempotent retry did not finish the disable: %v", err)
	}
	if keys.enabled["S-1-5-21-1000"] || platform.stops != 1 {
		t.Fatalf("retry did not disable keys and stop runtime: keys=%v stops=%d", keys.enabled, platform.stops)
	}
}

func TestLifecycleDisableStopFailureStaysDisabledAndRetries(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{stopErr: errors.New("task unavailable")}
	keys := newLifecycleKeys(nil, "S-1-5-21-1000", true)
	lifecycle := Lifecycle{Platform: platform, Users: data, Keys: keys}
	if _, err := lifecycle.SetEnabled(t.Context(), "alice", false); err == nil {
		t.Fatal("runtime stop failure was hidden")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled || keys.enabled["S-1-5-21-1000"] {
		t.Fatalf("partial disable state is not fail-closed: %+v keys=%v", stored, keys.enabled)
	}
	platform.stopErr = nil
	if _, err := lifecycle.SetEnabled(t.Context(), "alice", false); err != nil {
		t.Fatalf("retry after runtime stop failure did not recover: %v", err)
	}
	if platform.stops != 2 || keys.sets != 2 {
		t.Fatalf("retry did not replay shutdown idempotently: stops=%d key-sets=%d", platform.stops, keys.sets)
	}
}

func TestLifecycleEnableRestoresKeysBeforeRuntimeStart(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	var events []string
	platform := &lifecyclePlatform{events: &events}
	keys := newLifecycleKeys(&events, "S-1-5-21-1000", false)
	result, err := (Lifecycle{Platform: platform, Users: data, Keys: keys}).SetEnabled(t.Context(), "alice", true)
	if err != nil || result.Disabled {
		t.Fatalf("enable failed: result=%+v err=%v", result, err)
	}
	if !keys.enabled["S-1-5-21-1000"] {
		t.Fatal("gateway keys were not restored on enable")
	}
	if slices.Index(events, "keys:true") > slices.Index(events, "start") {
		t.Fatalf("gateway keys were not restored before the runtime start: %v", events)
	}
}

func TestLifecycleEnableStartFailureReDisablesKeys(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{startErr: errors.New("not healthy")}
	keys := newLifecycleKeys(nil, "S-1-5-21-1000", false)
	lifecycle := Lifecycle{Platform: platform, Users: data, Keys: keys}
	if _, err := lifecycle.SetEnabled(t.Context(), "alice", true); err == nil {
		t.Fatal("unhealthy runtime enabled the employee")
	}
	if keys.enabled["S-1-5-21-1000"] || keys.sets != 2 {
		t.Fatalf("failed enable left gateway keys enabled: keys=%v sets=%d", keys.enabled, keys.sets)
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled {
		t.Fatal("failed enable opened the Portal account")
	}
	platform.startErr = nil
	if _, err := lifecycle.SetEnabled(t.Context(), "alice", true); err != nil {
		t.Fatalf("retry after runtime start failure did not recover: %v", err)
	}
	if !keys.enabled["S-1-5-21-1000"] {
		t.Fatal("retry did not restore the gateway keys")
	}
}

func TestOffboardRetainDisablesKeysAndReplaysAfterFailure(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{removeErr: errors.New("task scheduler unavailable")}
	keys := newLifecycleKeys(nil, "S-1-5-21-1000", true)
	lifecycle := Lifecycle{Platform: platform, Users: data, Keys: keys}
	if _, err := lifecycle.OffboardRetain(t.Context(), "alice"); err == nil {
		t.Fatal("scheduled runtime removal failure was hidden")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled || stored.Offboarded || keys.enabled["S-1-5-21-1000"] {
		t.Fatalf("partial offboarding state is not recoverable: %+v keys=%v", stored, keys.enabled)
	}
	platform.removeErr = nil
	result, err := lifecycle.OffboardRetain(t.Context(), "alice")
	if err != nil || !result.Offboarded {
		t.Fatalf("retry did not finish the offboarding: result=%+v err=%v", result, err)
	}
	if keys.enabled["S-1-5-21-1000"] || keys.sets != 2 {
		t.Fatalf("retained employee keys are not disabled: keys=%v sets=%d", keys.enabled, keys.sets)
	}
}

func TestRepairDisablesKeysBeforeRotation(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	var events []string
	platform := &lifecyclePlatform{events: &events}
	keys := newLifecycleKeys(&events, "S-1-5-21-1000", true)
	result, err := (Lifecycle{Platform: platform, Users: data, Keys: keys}).Repair(t.Context(), "alice", []byte("windows repair password"))
	if err != nil || result.Disabled {
		t.Fatalf("repair failed: result=%+v err=%v", result, err)
	}
	if slices.Index(events, "keys:false") > slices.Index(events, "stop") || slices.Index(events, "stop") > slices.Index(events, "repair") {
		t.Fatalf("repair did not disable keys before stopping and rotating: %v", events)
	}
}

func TestRepairFailureReDisablesRotatedKeys(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	if err := data.SetUserOffboarded(t.Context(), "alice", true); err != nil {
		t.Fatal(err)
	}
	var events []string
	platform := &lifecyclePlatform{events: &events, repairErr: errors.New("task verification failed")}
	keys := newLifecycleKeys(&events, "S-1-5-21-1000", true)
	if _, err := (Lifecycle{Platform: platform, Users: data, Keys: keys}).Repair(t.Context(), "alice", []byte("windows repair password")); err == nil {
		t.Fatal("failed repair reopened employee")
	}
	// The in-place rotation inside repair may have re-enabled the keys; the
	// rollback must leave them disabled again.
	if keys.enabled["S-1-5-21-1000"] || events[len(events)-1] != "keys:false" {
		t.Fatalf("failed repair left gateway keys enabled: keys=%v events=%v", keys.enabled, events)
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled || !stored.Offboarded {
		t.Fatalf("failed repair changed retention state: %+v", stored)
	}
}

func TestRenameDisabledEmployeeDisablesKeysAgain(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	var events []string
	platform := &lifecyclePlatform{events: &events}
	keys := newLifecycleKeys(&events, "S-1-5-21-1000", true)
	result, err := (Lifecycle{Platform: platform, Users: data, Keys: keys}).RenameWindowsAccount(t.Context(), "alice", "alice2", []byte("windows rename password"))
	if err != nil || !result.Disabled {
		t.Fatalf("rename failed: result=%+v err=%v", result, err)
	}
	// Rename re-provisions (re-enables) the keys, but the employee stays
	// disabled, so the keys must end disabled.
	if keys.enabled["S-1-5-21-1000"] || events[len(events)-1] != "keys:false" {
		t.Fatalf("rename of a disabled employee left keys enabled: keys=%v events=%v", keys.enabled, events)
	}
}

func TestDeleteRetainedEmployeeRevokesKeysBeforeDeletion(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	if err := data.SetUserOffboarded(t.Context(), "alice", true); err != nil {
		t.Fatal(err)
	}
	var events []string
	platform := &lifecyclePlatform{events: &events}
	keys := newLifecycleKeys(&events, "S-1-5-21-1000", false)
	keys.revokeErr = errors.New("gateway unavailable")
	lifecycle := Lifecycle{Platform: platform, Users: data, Keys: keys}
	if err := lifecycle.DeleteRetainedEmployee(t.Context(), "alice", "DELETE alice"); err == nil {
		t.Fatal("key revocation failure was hidden")
	}
	if platform.deletes != 0 {
		t.Fatal("employee data was deleted while gateway keys were not revoked")
	}
	if _, err := data.UserByUsername(t.Context(), "alice"); err != nil {
		t.Fatal("failed revocation lost the retained mapping")
	}
	keys.revokeErr = nil
	if err := lifecycle.DeleteRetainedEmployee(t.Context(), "alice", "DELETE alice"); err != nil {
		t.Fatalf("retry after revocation failure did not recover: %v", err)
	}
	if slices.Index(events, "keys:revoke") > slices.Index(events, "delete") {
		t.Fatalf("gateway keys were not revoked before deletion: %v", events)
	}
	if _, err := data.UserByUsername(t.Context(), "alice"); err == nil {
		t.Fatal("deleted employee mapping survived")
	}
}
