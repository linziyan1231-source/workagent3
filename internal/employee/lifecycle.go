package employee

import (
	"context"
	"errors"
	"fmt"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

// LifecyclePlatform is the privileged operating-system boundary used by
// Employee Manager. Portal code must not implement or call these operations.
type LifecyclePlatform interface {
	StopInstalledRuntime(context.Context, string) error
	StartInstalledRuntime(context.Context, string) error
}

type CapacityPlatform interface {
	LifecyclePlatform
	UpdateInstalledLimits(context.Context, string, winutil.JobLimits) error
}

type RetentionPlatform interface {
	LifecyclePlatform
	RemoveInstalledRuntime(context.Context, string) error
}

type RepairPlatform interface {
	LifecyclePlatform
	RepairInstalledRuntime(context.Context, store.User, []byte) error
}

type RenamePlatform interface {
	LifecyclePlatform
	RenameInstalledAccount(context.Context, store.User, string, []byte) (string, error)
}

type DeletionPlatform interface {
	LifecyclePlatform
	DeleteRetainedEmployee(context.Context, store.User) error
}

type LifecycleUserStore interface {
	UserByUsername(context.Context, string) (store.User, error)
	SetUserEnabled(context.Context, string, bool) error
	ResetUserPassword(context.Context, string, string) error
	SetUserAdmin(context.Context, string, bool) error
	SetUserOffboarded(context.Context, string, bool) error
	SetWindowsUsername(context.Context, int64, string) error
	DeleteOffboardedUser(context.Context, string) error
}

// Lifecycle coordinates Portal account state with the SID-owned runtime. Its
// ordering is fail-closed: disable the account before stopping the runtime,
// and prove the runtime healthy before enabling the account.
type Lifecycle struct {
	Platform LifecyclePlatform
	Users    LifecycleUserStore
}

func (l Lifecycle) SetEnabled(ctx context.Context, username string, enabled bool) (store.User, error) {
	if l.Platform == nil || l.Users == nil {
		return store.User{}, errors.New("employee lifecycle dependencies are required")
	}
	user, err := l.Users.UserByUsername(ctx, username)
	if err != nil {
		return store.User{}, err
	}
	if enabled {
		if !user.Disabled {
			return user, nil
		}
		if err := l.Platform.StartInstalledRuntime(ctx, user.SID); err != nil {
			return store.User{}, fmt.Errorf("start employee runtime: %w", err)
		}
		if err := l.Users.SetUserEnabled(ctx, username, true); err != nil {
			rollbackContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			_ = l.Platform.StopInstalledRuntime(rollbackContext, user.SID)
			cancel()
			return store.User{}, err
		}
		user.Disabled = false
		return user, nil
	}

	if user.Disabled {
		return user, nil
	}
	if err := l.Users.SetUserEnabled(ctx, username, false); err != nil {
		return store.User{}, err
	}
	user.Disabled = true
	if err := l.Platform.StopInstalledRuntime(ctx, user.SID); err != nil {
		return user, fmt.Errorf("Portal account disabled but employee runtime stop failed: %w", err)
	}
	return user, nil
}

func (l Lifecycle) ResetPortalPassword(ctx context.Context, username string, password []byte) error {
	defer zero(password)
	if l.Users == nil {
		return errors.New("employee lifecycle user store is required")
	}
	if _, err := l.Users.UserByUsername(ctx, username); err != nil {
		return err
	}
	if err := auth.ValidatePassword(password); err != nil {
		return err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	return l.Users.ResetUserPassword(ctx, username, hash)
}

func (l Lifecycle) SetPortalAdmin(ctx context.Context, username string, admin bool) (store.User, error) {
	if l.Users == nil {
		return store.User{}, errors.New("employee lifecycle user store is required")
	}
	user, err := l.Users.UserByUsername(ctx, username)
	if err != nil {
		return store.User{}, err
	}
	if user.Admin == admin {
		return user, nil
	}
	if err := l.Users.SetUserAdmin(ctx, username, admin); err != nil {
		return store.User{}, err
	}
	user.Admin = admin
	return user, nil
}

// SetLimits replaces the UserHost Job Object under a closed Portal account.
// Any mutation or health-check failure leaves the employee disabled.
func (l Lifecycle) SetLimits(ctx context.Context, username string, limits winutil.JobLimits) (store.User, error) {
	platform, ok := l.Platform.(CapacityPlatform)
	if !ok || l.Users == nil {
		return store.User{}, errors.New("employee capacity dependencies are required")
	}
	if err := winutil.ValidateJobLimits(limits); err != nil {
		return store.User{}, err
	}
	user, err := l.Users.UserByUsername(ctx, username)
	if err != nil {
		return store.User{}, err
	}
	wasEnabled := !user.Disabled
	if wasEnabled {
		if err := l.Users.SetUserEnabled(ctx, username, false); err != nil {
			return store.User{}, err
		}
		user.Disabled = true
		if err := platform.StopInstalledRuntime(ctx, user.SID); err != nil {
			return user, fmt.Errorf("Portal account disabled but employee runtime stop failed: %w", err)
		}
	}
	if err := platform.UpdateInstalledLimits(ctx, user.SID, limits); err != nil {
		return user, fmt.Errorf("update employee runtime limits: %w", err)
	}
	if !wasEnabled {
		return user, nil
	}
	if err := platform.StartInstalledRuntime(ctx, user.SID); err != nil {
		return user, fmt.Errorf("limits updated but employee runtime health check failed: %w", err)
	}
	if err := l.Users.SetUserEnabled(ctx, username, true); err != nil {
		rollbackContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		_ = platform.StopInstalledRuntime(rollbackContext, user.SID)
		cancel()
		return user, err
	}
	user.Disabled = false
	return user, nil
}

func (l Lifecycle) OffboardRetain(ctx context.Context, username string) (store.User, error) {
	platform, ok := l.Platform.(RetentionPlatform)
	if !ok || l.Users == nil {
		return store.User{}, errors.New("employee retention dependencies are required")
	}
	user, err := l.Users.UserByUsername(ctx, username)
	if err != nil {
		return store.User{}, err
	}
	if user.Admin {
		return store.User{}, errors.New("administrator account cannot be offboarded as an employee")
	}
	if user.Offboarded {
		return user, nil
	}
	if !user.Disabled {
		if err := l.Users.SetUserEnabled(ctx, username, false); err != nil {
			return store.User{}, err
		}
		user.Disabled = true
		if err := platform.StopInstalledRuntime(ctx, user.SID); err != nil {
			return user, fmt.Errorf("Portal account disabled but employee runtime stop failed: %w", err)
		}
	}
	if err := platform.RemoveInstalledRuntime(ctx, user.SID); err != nil {
		return user, fmt.Errorf("employee data retained but scheduled runtime removal failed: %w", err)
	}
	if err := l.Users.SetUserOffboarded(ctx, username, true); err != nil {
		return user, err
	}
	user.Offboarded = true
	return user, nil
}

func (l Lifecycle) Repair(ctx context.Context, username string, windowsPassword []byte) (store.User, error) {
	defer zero(windowsPassword)
	platform, ok := l.Platform.(RepairPlatform)
	if !ok || l.Users == nil {
		return store.User{}, errors.New("employee repair dependencies are required")
	}
	if len(windowsPassword) == 0 {
		return store.User{}, errors.New("Windows password is required for repair")
	}
	user, err := l.Users.UserByUsername(ctx, username)
	if err != nil {
		return store.User{}, err
	}
	if !user.Disabled {
		if err := l.Users.SetUserEnabled(ctx, username, false); err != nil {
			return store.User{}, err
		}
		user.Disabled = true
		if err := platform.StopInstalledRuntime(ctx, user.SID); err != nil {
			return user, fmt.Errorf("Portal account disabled but employee runtime stop failed: %w", err)
		}
	}
	if err := platform.RepairInstalledRuntime(ctx, user, windowsPassword); err != nil {
		return user, fmt.Errorf("repair employee runtime: %w", err)
	}
	if user.Offboarded {
		if err := l.Users.SetUserOffboarded(ctx, username, false); err != nil {
			_ = platform.StopInstalledRuntime(context.WithoutCancel(ctx), user.SID)
			return user, err
		}
		user.Offboarded = false
	}
	if err := l.Users.SetUserEnabled(ctx, username, true); err != nil {
		_ = platform.StopInstalledRuntime(context.WithoutCancel(ctx), user.SID)
		return user, err
	}
	user.Disabled = false
	return user, nil
}

func (l Lifecycle) RenameWindowsAccount(ctx context.Context, username, newWindowsUsername string, windowsPassword []byte) (store.User, error) {
	defer zero(windowsPassword)
	platform, ok := l.Platform.(RenamePlatform)
	if !ok || l.Users == nil {
		return store.User{}, errors.New("employee rename dependencies are required")
	}
	if err := winutil.ValidateLocalUsername(newWindowsUsername); err != nil {
		return store.User{}, err
	}
	if len(windowsPassword) == 0 {
		return store.User{}, errors.New("Windows password is required for rename")
	}
	user, err := l.Users.UserByUsername(ctx, username)
	if err != nil {
		return store.User{}, err
	}
	if user.Admin || user.Offboarded {
		return store.User{}, errors.New("active managed employee is required for Windows rename")
	}
	wasEnabled := !user.Disabled
	if wasEnabled {
		if err := l.Users.SetUserEnabled(ctx, username, false); err != nil {
			return store.User{}, err
		}
		user.Disabled = true
		if err := platform.StopInstalledRuntime(ctx, user.SID); err != nil {
			return user, fmt.Errorf("Portal account disabled but employee runtime stop failed: %w", err)
		}
	}
	canonical, err := platform.RenameInstalledAccount(ctx, user, newWindowsUsername, windowsPassword)
	if err != nil {
		return user, fmt.Errorf("rename Windows account: %w", err)
	}
	if err := l.Users.SetWindowsUsername(ctx, user.ID, canonical); err != nil {
		return user, err
	}
	user.WindowsUsername = canonical
	if !wasEnabled {
		_ = platform.StopInstalledRuntime(context.WithoutCancel(ctx), user.SID)
		return user, nil
	}
	if err := l.Users.SetUserEnabled(ctx, username, true); err != nil {
		_ = platform.StopInstalledRuntime(context.WithoutCancel(ctx), user.SID)
		return user, err
	}
	user.Disabled = false
	return user, nil
}

func (l Lifecycle) DeleteRetainedEmployee(ctx context.Context, username, confirmation string) error {
	platform, ok := l.Platform.(DeletionPlatform)
	if !ok || l.Users == nil {
		return errors.New("employee deletion dependencies are required")
	}
	if confirmation != "DELETE "+username {
		return errors.New("exact employee deletion confirmation is required")
	}
	user, err := l.Users.UserByUsername(ctx, username)
	if err != nil {
		return err
	}
	if user.Admin || !user.Disabled || !user.Offboarded {
		return errors.New("only a retained offboarded employee can be deleted")
	}
	if err := platform.DeleteRetainedEmployee(ctx, user); err != nil {
		return fmt.Errorf("delete retained employee data: %w", err)
	}
	return l.Users.DeleteOffboardedUser(ctx, username)
}
