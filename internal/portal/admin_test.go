package portal

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

type fakeEmployeeManagement struct {
	startedUsername string
	startedPassword string
	action          string
	actionUsername  string
	actionValue     string
}

func (f *fakeEmployeeManagement) StartMaintenance(ctx context.Context, action, username, newName string) (ProvisionJob, error) {
	switch action {
	case "repair":
		f.Repair(ctx, username, nil)
	case "restart":
		f.Restart(ctx, username)
	case "rename-windows":
		f.RenameWindowsAccount(ctx, username, newName, nil)
	}
	return ProvisionJob{ID: "maintenance-test", Username: username, Status: "running"}, nil
}

func TestAdministratorExtendedEmployeeActionsUsePort(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	admin, _ := data.CreateUser(t.Context(), "manager", "S-1-5-21-9000", "hash")
	_ = data.SetUserAdmin(t.Context(), admin.Username, true)
	_ = data.CreateSession(t.Context(), "admin-session", admin.ID, time.Now().Add(time.Hour))
	port := &fakeEmployeeManagement{}
	server, _ := NewWithModules(data, StaticRouter{}, false, Modules{EmployeeManagement: port})

	tests := []struct {
		action string
		body   string
		want   string
	}{
		{"repair", `{"username":"alice"}`, ""},
		{"restart", `{"username":"alice"}`, ""},
		{"rename-windows", `{"username":"alice","new_windows_username":"alice2"}`, "alice2:"},
		{"set-limits", `{"username":"alice","limits":{"memory_bytes":536870912,"cpu_percent":50,"active_processes":8}}`, "536870912"},
		{"offboard-retain", `{"username":"alice"}`, ""},
		{"offboard-delete", `{"username":"alice","confirmation":"DELETE alice"}`, "DELETE alice"},
	}
	for _, test := range tests {
		t.Run(test.action, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/portal/admin/users/"+test.action, strings.NewReader(test.body))
			request.Header.Set("Origin", "http://portal.test")
			request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "admin-session"})
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusOK || port.action != test.action || port.actionUsername != "alice" || port.actionValue != test.want {
				t.Fatalf("action was not forwarded: status=%d port=%#v body=%s", response.Code, port, response.Body.String())
			}
		})
	}
	requestWithPassword := httptest.NewRequest(http.MethodPost, "http://portal.test/api/portal/admin/users/repair", strings.NewReader(`{"username":"alice","windows_password":"must-not-reset"}`))
	requestWithPassword.Header.Set("Origin", "http://portal.test")
	requestWithPassword.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "admin-session"})
	rejected := httptest.NewRecorder()
	server.Handler().ServeHTTP(rejected, requestWithPassword)
	if rejected.Code != http.StatusBadRequest {
		t.Fatal("repair accepted an explicit Windows password")
	}

	request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/portal/admin/users/offboard-delete", strings.NewReader(`{"username":"alice","confirmation":"alice"}`))
	request.Header.Set("Origin", "http://portal.test")
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "admin-session"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unsafe delete confirmation status %d: %s", response.Code, response.Body.String())
	}
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
func (f *fakeEmployeeManagement) Repair(_ context.Context, username string, password []byte) error {
	f.action, f.actionUsername, f.actionValue = "repair", username, string(password)
	return nil
}
func (f *fakeEmployeeManagement) Restart(_ context.Context, username string) error {
	f.action = "restart"
	f.actionUsername = username
	f.actionValue = ""
	return nil
}
func (f *fakeEmployeeManagement) RenameWindowsAccount(_ context.Context, username, newWindowsUsername string, password []byte) error {
	f.action, f.actionUsername, f.actionValue = "rename-windows", username, newWindowsUsername+":"+string(password)
	return nil
}
func (f *fakeEmployeeManagement) SetLimits(_ context.Context, username string, limits contracts.EmployeeResourceLimits) error {
	f.action, f.actionUsername, f.actionValue = "set-limits", username, fmt.Sprint(limits.MemoryBytes)
	return nil
}
func (f *fakeEmployeeManagement) OffboardRetain(_ context.Context, username string) error {
	f.action, f.actionUsername, f.actionValue = "offboard-retain", username, ""
	return nil
}
func (f *fakeEmployeeManagement) DeleteRetainedEmployee(_ context.Context, username, confirmation string) error {
	f.action, f.actionUsername, f.actionValue = "offboard-delete", username, confirmation
	return nil
}
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
