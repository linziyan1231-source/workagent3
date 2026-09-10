package employeemanager

import (
	"context"
	"testing"
	"workagent3/internal/employee"
	"workagent3/internal/store"
)

type runtimeStartPlatform struct{ started []string }

func (p *runtimeStartPlatform) StartInstalledRuntime(_ context.Context, sid string) error {
	p.started = append(p.started, sid)
	return nil
}
func (p *runtimeStartPlatform) StopInstalledRuntime(context.Context, string) error { return nil }
func TestRuntimeWakeIncludesEnabledAdministratorsButRejectsDisabledAccounts(t *testing.T) {
	platform := &runtimeStartPlatform{}
	service := Service{Users: listStore{users: []store.User{{SID: "admin-sid", Admin: true}, {SID: "disabled-sid", Disabled: true}, {SID: "retained-sid", Offboarded: true}}}, Lifecycle: employee.Lifecycle{Platform: platform}}
	if err := service.EnsureRuntime(t.Context(), "admin-sid"); err != nil {
		t.Fatal(err)
	}
	for _, sid := range []string{"disabled-sid", "retained-sid", "unknown"} {
		if err := service.EnsureRuntime(t.Context(), sid); err == nil {
			t.Fatalf("started %s", sid)
		}
	}
	if len(platform.started) != 1 || platform.started[0] != "admin-sid" {
		t.Fatal(platform.started)
	}
}
