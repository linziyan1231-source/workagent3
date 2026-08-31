package employee

import (
	"context"
	"errors"
	"testing"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

type lifecyclePlatform struct {
	starts    int
	stops     int
	startErr  error
	stopErr   error
	updateErr error
	limits    winutil.JobLimits
	removes   int
	removeErr error
	repairs   int
	repairErr error
	renames   int
	renameErr error
}

type failingEnableStore struct{ *store.Store }

func (s failingEnableStore) SetUserEnabled(ctx context.Context, username string, enabled bool) error {
	if enabled {
		return errors.New("database unavailable")
	}
	return s.Store.SetUserEnabled(ctx, username, enabled)
}

func (p *lifecyclePlatform) StartInstalledRuntime(context.Context, string) error {
	p.starts++
	return p.startErr
}
func (p *lifecyclePlatform) StopInstalledRuntime(context.Context, string) error {
	p.stops++
	return p.stopErr
}
func (p *lifecyclePlatform) UpdateInstalledLimits(_ context.Context, _ string, limits winutil.JobLimits) error {
	p.limits = limits
	return p.updateErr
}
func (p *lifecyclePlatform) RemoveInstalledRuntime(context.Context, string) error {
	p.removes++
	return p.removeErr
}
func (p *lifecyclePlatform) RepairInstalledRuntime(_ context.Context, _ store.User, password []byte) error {
	p.repairs++
	if len(password) == 0 {
		return errors.New("missing password")
	}
	return p.repairErr
}
func (p *lifecyclePlatform) RenameInstalledAccount(_ context.Context, user store.User, newUsername string, password []byte) (string, error) {
	p.renames++
	if p.renameErr != nil {
		return "", p.renameErr
	}
	if user.SID == "" || len(password) == 0 {
		return "", errors.New("invalid rename input")
	}
	return `WORKSTATION\` + newUsername, nil
}

func TestLifecycleDisableRevokesSessionsBeforeRuntimeStop(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "old-hash")
	if err := data.CreateSession(t.Context(), "active", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{stopErr: errors.New("task unavailable")}
	result, err := (Lifecycle{Platform: platform, Users: data}).SetEnabled(t.Context(), "alice", false)
	if err == nil || !result.Disabled || platform.stops != 1 {
		t.Fatalf("disable did not fail closed: result=%+v err=%v", result, err)
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled {
		t.Fatal("Portal account was re-enabled after runtime stop failure")
	}
	if _, err := data.UserBySession(t.Context(), "active", time.Now()); err == nil {
		t.Fatal("existing browser session survived employee disable")
	}
}

func TestLifecycleEnableRequiresHealthyRuntime(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{startErr: errors.New("not healthy")}
	if _, err := (Lifecycle{Platform: platform, Users: data}).SetEnabled(t.Context(), "alice", true); err == nil {
		t.Fatal("unhealthy runtime enabled the employee")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled || platform.starts != 1 {
		t.Fatalf("employee was not kept disabled: %+v", stored)
	}
	platform.startErr = nil
	result, err := (Lifecycle{Platform: platform, Users: data}).SetEnabled(t.Context(), "alice", true)
	if err != nil || result.Disabled {
		t.Fatalf("healthy runtime did not enable employee: result=%+v err=%v", result, err)
	}
}

func TestLifecycleStopsRuntimeWhenEnableCommitFails(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &lifecyclePlatform{}
	_, err := (Lifecycle{Platform: platform, Users: failingEnableStore{data}}).SetEnabled(t.Context(), "alice", true)
	if err == nil || platform.starts != 1 || platform.stops != 1 {
		t.Fatalf("enable rollback did not stop Runtime: starts=%d stops=%d err=%v", platform.starts, platform.stops, err)
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled {
		t.Fatal("failed enable commit opened the Portal account")
	}
}

func TestLifecyclePasswordResetRevokesSessions(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "old-hash")
	_ = data.CreateSession(t.Context(), "active", user.ID, time.Now().Add(time.Hour))
	password := []byte("replacement portal password")
	if err := (Lifecycle{Users: data}).ResetPortalPassword(t.Context(), "alice", password); err != nil {
		t.Fatal(err)
	}
	if string(password) != string(make([]byte, len(password))) {
		t.Fatal("caller password buffer was not cleared")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !auth.VerifyPassword(stored.PasswordHash, []byte("replacement portal password")) {
		t.Fatal("new Portal password was not stored")
	}
	if _, err := data.UserBySession(t.Context(), "active", time.Now()); err == nil {
		t.Fatal("existing browser session survived password reset")
	}
}

func TestLifecycleCapacityChangeRestartsBeforeReopeningAccount(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	_ = data.CreateSession(t.Context(), "active", user.ID, time.Now().Add(time.Hour))
	platform := &lifecyclePlatform{}
	limits := winutil.JobLimits{MemoryBytes: 2 * 1024 * 1024 * 1024, CPUPercent: 40, ActiveProcesses: 32}
	updated, err := (Lifecycle{Platform: platform, Users: data}).SetLimits(t.Context(), "alice", limits)
	if err != nil || updated.Disabled || platform.stops != 1 || platform.starts != 1 || platform.limits != limits {
		t.Fatalf("capacity update was not fully composed: user=%+v platform=%+v err=%v", updated, platform, err)
	}
	if _, err := data.UserBySession(t.Context(), "active", time.Now()); err == nil {
		t.Fatal("capacity restart preserved a stale browser session")
	}
}

func TestLifecycleCapacityFailureLeavesEmployeeDisabled(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	_, _ = data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	platform := &lifecyclePlatform{startErr: errors.New("runtime unhealthy")}
	limits := winutil.JobLimits{MemoryBytes: 1024 * 1024 * 1024, CPUPercent: 25, ActiveProcesses: 16}
	if _, err := (Lifecycle{Platform: platform, Users: data}).SetLimits(t.Context(), "alice", limits); err == nil {
		t.Fatal("unhealthy Runtime accepted capacity change")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled {
		t.Fatal("capacity failure reopened the Portal account")
	}
}

func TestOffboardRetainFreezesEmployeeWithoutDeletingIdentity(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	_ = data.CreateSession(t.Context(), "active", user.ID, time.Now().Add(time.Hour))
	platform := &lifecyclePlatform{}
	result, err := (Lifecycle{Platform: platform, Users: data}).OffboardRetain(t.Context(), "alice")
	if err != nil || !result.Disabled || !result.Offboarded || platform.stops != 1 || platform.removes != 1 {
		t.Fatalf("retained offboarding was incomplete: user=%+v platform=%+v err=%v", result, platform, err)
	}
	stored, err := data.UserByUsername(t.Context(), "alice")
	if err != nil || stored.SID != user.SID || !stored.Offboarded {
		t.Fatalf("retained identity was lost: %+v %v", stored, err)
	}
	if _, err := data.UserBySession(t.Context(), "active", time.Now()); err == nil {
		t.Fatal("offboarded employee kept an active session")
	}
	if _, err := (Lifecycle{Platform: platform, Users: data}).SetEnabled(t.Context(), "alice", true); err == nil {
		t.Fatal("ordinary enable bypassed retained-offboard state")
	}
}

func TestOffboardRetainFailureStillLeavesAccountDisabled(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	_, _ = data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	platform := &lifecyclePlatform{removeErr: errors.New("task scheduler unavailable")}
	if _, err := (Lifecycle{Platform: platform, Users: data}).OffboardRetain(t.Context(), "alice"); err == nil {
		t.Fatal("scheduled runtime removal failure was hidden")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled || stored.Offboarded {
		t.Fatalf("partial offboarding state is not recoverable: %+v", stored)
	}
}

func TestRepairRestoresRetainedEmployeeOnlyAfterRuntimeHealth(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	_, _ = data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	_ = data.SetUserOffboarded(t.Context(), "alice", true)
	platform := &lifecyclePlatform{}
	password := []byte("windows repair password")
	result, err := (Lifecycle{Platform: platform, Users: data}).Repair(t.Context(), "alice", password)
	if err != nil || result.Disabled || result.Offboarded || platform.repairs != 1 {
		t.Fatalf("repair did not restore employee: user=%+v platform=%+v err=%v", result, platform, err)
	}
	if string(password) != string(make([]byte, len(password))) {
		t.Fatal("Windows repair password buffer was not cleared")
	}
}

func TestRepairFailureKeepsRetainedEmployeeClosed(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	_, _ = data.CreateDisabledUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	_ = data.SetUserOffboarded(t.Context(), "alice", true)
	platform := &lifecyclePlatform{repairErr: errors.New("task verification failed")}
	if _, err := (Lifecycle{Platform: platform, Users: data}).Repair(t.Context(), "alice", []byte("windows repair password")); err == nil {
		t.Fatal("failed repair reopened employee")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled || !stored.Offboarded {
		t.Fatalf("failed repair changed retention state: %+v", stored)
	}
}

func TestRenameWindowsAccountKeepsPortalIdentityAndSID(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice.portal", "S-1-5-21-1000", "hash")
	_ = data.SetWindowsUsername(t.Context(), user.ID, `WORKSTATION\alice`)
	platform := &lifecyclePlatform{}
	result, err := (Lifecycle{Platform: platform, Users: data}).RenameWindowsAccount(t.Context(), "alice.portal", "alice2", []byte("windows rename password"))
	if err != nil || result.Username != "alice.portal" || result.SID != user.SID || result.WindowsUsername != `WORKSTATION\alice2` || result.Disabled {
		t.Fatalf("Windows rename changed employee identity: %+v err=%v", result, err)
	}
	stored, _ := data.UserByUsername(t.Context(), "alice.portal")
	if stored.WindowsUsername != `WORKSTATION\alice2` || stored.SID != user.SID || platform.stops != 1 || platform.renames != 1 {
		t.Fatalf("rename was not persisted safely: user=%+v platform=%+v", stored, platform)
	}
}

func TestRenameWindowsAccountFailureLeavesPortalClosed(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	_, _ = data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	platform := &lifecyclePlatform{renameErr: errors.New("rename failed")}
	if _, err := (Lifecycle{Platform: platform, Users: data}).RenameWindowsAccount(t.Context(), "alice", "alice2", []byte("windows rename password")); err == nil {
		t.Fatal("failed Windows rename was accepted")
	}
	stored, _ := data.UserByUsername(t.Context(), "alice")
	if !stored.Disabled || stored.WindowsUsername != "alice" {
		t.Fatalf("failed rename was not recoverable: %+v", stored)
	}
}
