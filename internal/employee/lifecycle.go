package employee

import (
	"context"
	"errors"
	"fmt"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/store"
)

// LifecyclePlatform is the privileged operating-system boundary used by
// Employee Manager. Portal code must not implement or call these operations.
type LifecyclePlatform interface {
	StopInstalledRuntime(context.Context, string) error
	StartInstalledRuntime(context.Context, string) error
}

type LifecycleUserStore interface {
	UserByUsername(context.Context, string) (store.User, error)
	SetUserEnabled(context.Context, string, bool) error
	ResetUserPassword(context.Context, string, string) error
	SetUserAdmin(context.Context, string, bool) error
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
