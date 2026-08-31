package portal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

type fakeEmployeeManagement struct {
	startedUsername string
	startedPassword string
}

func (f *fakeEmployeeManagement) ListManagedUsers(context.Context) ([]ManagedUser, []string, error) {
	return []ManagedUser{{Username: "alice", WindowsUsername: `HOST\alice`, WindowsSID: "S-1-5-21-1000", Enabled: true, CreatedAt: time.Unix(1, 0).UTC()}}, []string{"kimi_search"}, nil
}
func (f *fakeEmployeeManagement) StartProvision(_ context.Context, username string, password []byte) (ProvisionJob, error) {
	f.startedUsername, f.startedPassword = username, string(password)
	return ProvisionJob{ID: "job-1", Username: username, Status: "running", Percent: 5, Step: "queued"}, nil
}
func (*fakeEmployeeManagement) ProvisionJob(context.Context, string) (ProvisionJob, error) {
	return ProvisionJob{ID: "job-1", Username: "bob", Status: "succeeded", Percent: 100, Step: "completed"}, nil
}
func (*fakeEmployeeManagement) ManagedUsersUsage(context.Context) ([]ManagedUserUsage, error) {
	return []ManagedUserUsage{{Username: "alice", ResourceUsageUnavailable: true}}, nil
}
func (*fakeEmployeeManagement) SetEnabled(context.Context, string, bool) error      { return nil }
func (*fakeEmployeeManagement) ResetPassword(context.Context, string, []byte) error { return nil }
func (*fakeEmployeeManagement) SetKimiDatasource(_ context.Context, _ string, grant KimiDatasourceGrant) (KimiDatasourceGrant, error) {
	return grant, nil
}

func TestAdministratorRoutesUseEmployeeManagementPort(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	admin, err := data.CreateUser(t.Context(), "manager", "S-1-5-21-9000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := data.SetUserAdmin(t.Context(), admin.Username, true); err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(t.Context(), "admin-session", admin.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	port := &fakeEmployeeManagement{}
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{EmployeeManagement: port})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodGet, "/api/portal/admin/users", nil)
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "admin-session"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"windows_sid":"S-1-5-21-1000"`) {
		t.Fatalf("managed user list was not projected: %d %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "http://portal.test/api/portal/admin/users", strings.NewReader(`{"username":"bob","portal_password":"correct horse battery staple"}`))
	request.Header.Set("Origin", "http://portal.test")
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "admin-session"})
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || port.startedUsername != "bob" || port.startedPassword != "correct horse battery staple" {
		t.Fatalf("provision request did not cross the explicit Port: %d %#v %s", response.Code, port, response.Body.String())
	}
}

func TestNonAdministratorCannotReachEmployeeManagementPort(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash")
	_ = data.CreateSession(t.Context(), "user-session", user.ID, time.Now().Add(time.Hour))
	server, _ := NewWithModules(data, runtimeapi.NewRegistry(), false, Modules{EmployeeManagement: &fakeEmployeeManagement{}})
	request := httptest.NewRequest(http.MethodGet, "/api/portal/admin/users", nil)
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "user-session"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-admin status %d: %s", response.Code, response.Body.String())
	}
}
