package employee

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"workagent3/internal/auth"
	"workagent3/internal/store"
)

type Account struct {
	SID       string
	Canonical string
}

type RuntimeSpec struct {
	SID                    string
	CanonicalUsername      string
	DataRoot               string
	RegistrationCredential string
}

type Platform interface {
	EnsureAccount(context.Context, string, []byte) (Account, error)
	EnsureProfile(context.Context, Account, string, []byte) error
	EnsurePrivateDataRoot(context.Context, Account) (string, error)
	InstallRuntime(context.Context, RuntimeSpec, []byte) error
	StartRuntime(context.Context, RuntimeSpec) error
}

type UserStore interface {
	UserByUsername(context.Context, string) (store.User, error)
	CreateDisabledUser(context.Context, string, string, string) (store.User, error)
	SetUserCredentials(context.Context, int64, string, bool) error
}

type RuntimeAuthorizer interface {
	AuthorizeRuntime(context.Context, string, string) error
}

type SecretSource interface {
	WindowsPassword() ([]byte, error)
	RegistrationCredential() (string, error)
}

type Provisioner struct {
	Platform Platform
	Users    UserStore
	Runtimes RuntimeAuthorizer
	Secrets  SecretSource
}

func (p *Provisioner) Add(ctx context.Context, username string, portalPassword []byte) (result store.User, resultErr error) {
	defer zero(portalPassword)
	if p.Platform == nil || p.Users == nil || p.Runtimes == nil || p.Secrets == nil {
		return store.User{}, errors.New("employee provisioner dependencies are required")
	}
	if err := auth.ValidateUsername(username); err != nil {
		return store.User{}, err
	}
	if err := auth.ValidatePassword(portalPassword); err != nil {
		return store.User{}, err
	}
	existing, lookupErr := p.Users.UserByUsername(ctx, username)
	if lookupErr == nil && !existing.Disabled {
		return store.User{}, errors.New("Portal username already exists")
	}
	if lookupErr != nil && !errors.Is(lookupErr, sql.ErrNoRows) {
		return store.User{}, lookupErr
	}
	windowsPassword, err := p.Secrets.WindowsPassword()
	if err != nil {
		return store.User{}, err
	}
	defer zero(windowsPassword)
	account, err := p.Platform.EnsureAccount(ctx, username, windowsPassword)
	if err != nil {
		return store.User{}, fmt.Errorf("ensure Windows account: %w", err)
	}
	if lookupErr == nil && existing.SID != account.SID {
		return store.User{}, errors.New("disabled Portal account does not match the Windows SID")
	}
	if err := p.Platform.EnsureProfile(ctx, account, username, windowsPassword); err != nil {
		return store.User{}, fmt.Errorf("ensure Windows profile: %w", err)
	}
	dataRoot, err := p.Platform.EnsurePrivateDataRoot(ctx, account)
	if err != nil {
		return store.User{}, fmt.Errorf("ensure private data root: %w", err)
	}
	hash, err := auth.HashPassword(portalPassword)
	if err != nil {
		return store.User{}, err
	}
	user := existing
	if lookupErr != nil {
		user, err = p.Users.CreateDisabledUser(ctx, username, account.SID, hash)
	} else {
		err = p.Users.SetUserCredentials(ctx, existing.ID, hash, true)
		user.PasswordHash = hash
	}
	if err != nil {
		return store.User{}, err
	}
	credential, err := p.Secrets.RegistrationCredential()
	if err != nil {
		return store.User{}, err
	}
	if err := p.Runtimes.AuthorizeRuntime(ctx, account.SID, credential); err != nil {
		return store.User{}, err
	}
	spec := RuntimeSpec{SID: account.SID, CanonicalUsername: account.Canonical, DataRoot: dataRoot, RegistrationCredential: credential}
	if err := p.Platform.InstallRuntime(ctx, spec, windowsPassword); err != nil {
		return store.User{}, fmt.Errorf("install employee runtime: %w", err)
	}
	if err := p.Platform.StartRuntime(ctx, spec); err != nil {
		return store.User{}, fmt.Errorf("start employee runtime: %w", err)
	}
	if err := p.Users.SetUserCredentials(ctx, user.ID, hash, false); err != nil {
		return store.User{}, err
	}
	user.Disabled = false
	return user, nil
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
