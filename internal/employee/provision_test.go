package employee

import (
	"context"
	"errors"
	"testing"

	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

type fakePlatform struct {
	calls     []string
	failStart bool
}

func (p *fakePlatform) EnsureAccount(_ context.Context, username string, password []byte) (Account, error) {
	p.calls = append(p.calls, "account")
	if username != "alice" || len(password) == 0 {
		return Account{}, errors.New("bad account input")
	}
	return Account{SID: "S-1-5-21-1000", Canonical: `WORKSTATION\alice`}, nil
}
func (p *fakePlatform) EnsureProfile(context.Context, Account, string, []byte) error {
	p.calls = append(p.calls, "profile")
	return nil
}
func (p *fakePlatform) EnsurePrivateDataRoot(context.Context, Account) (string, error) {
	p.calls = append(p.calls, "data-root")
	return `C:\WorkAgent\users\S-1-5-21-1000`, nil
}
func (p *fakePlatform) InstallRuntime(_ context.Context, spec RuntimeSpec, password []byte) error {
	p.calls = append(p.calls, "install")
	if spec.RegistrationCredential == "" || len(password) == 0 {
		return errors.New("missing runtime secret")
	}
	return nil
}
func (p *fakePlatform) StartRuntime(context.Context, RuntimeSpec) error {
	p.calls = append(p.calls, "start")
	if p.failStart {
		return errors.New("not ready")
	}
	return nil
}

type fixedSecrets struct{}

func (fixedSecrets) WindowsPassword() ([]byte, error)        { return []byte("Windows!Password123"), nil }
func (fixedSecrets) RegistrationCredential() (string, error) { return "registration-secret", nil }

func TestProvisionerLeavesFailedRuntimeDisabledAndResumes(t *testing.T) {
	users, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	platform := &fakePlatform{failStart: true}
	runtimes := runtimeapi.NewRegistry()
	provisioner := Provisioner{Platform: platform, Users: users, Runtimes: runtimes, Secrets: fixedSecrets{}}
	password := []byte("correct horse battery staple")
	if _, err := provisioner.Add(t.Context(), "alice", append([]byte(nil), password...)); err == nil {
		t.Fatal("failed runtime start was accepted")
	}
	user, err := users.UserByUsername(t.Context(), "alice")
	if err != nil || !user.Disabled {
		t.Fatalf("partially provisioned user is not disabled: user=%+v err=%v", user, err)
	}
	platform.failStart = false
	user, err = provisioner.Add(t.Context(), "alice", append([]byte(nil), password...))
	if err != nil {
		t.Fatal(err)
	}
	if user.Disabled {
		t.Fatal("healthy provisioned user remains disabled")
	}
}

func TestProvisionerDoesNotModifyEnabledUser(t *testing.T) {
	users, _ := store.Open(":memory:")
	defer users.Close()
	if _, err := users.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	platform := &fakePlatform{}
	provisioner := Provisioner{Platform: platform, Users: users, Runtimes: runtimeapi.NewRegistry(), Secrets: fixedSecrets{}}
	if _, err := provisioner.Add(t.Context(), "alice", []byte("correct horse battery staple")); err == nil {
		t.Fatal("enabled user was reprovisioned")
	}
	if len(platform.calls) != 0 {
		t.Fatalf("platform was called for existing user: %v", platform.calls)
	}
}
