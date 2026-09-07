package portal

import (
	"context"
	"net/http"
	"strings"

	"workagent3/internal/auth"
	"workagent3/internal/contracts"
	"workagent3/internal/quota"
	"workagent3/internal/store"
)

type ManagedUser = contracts.ManagedEmployee
type KimiDatasourceGrant = contracts.KimiDatasourceGrant
type ProvisionJob = contracts.EmployeeProvisionJob
type ManagedUserUsage = contracts.ManagedEmployeeUsage

type EmployeeManagementPort interface {
	StartMaintenance(context.Context, string, string, string) (ProvisionJob, error)
	ListManagedUsers(context.Context) ([]ManagedUser, []string, error)
	StartProvision(context.Context, string, []byte) (ProvisionJob, error)
	ProvisionJob(context.Context, string) (ProvisionJob, error)
	ManagedUsersUsage(context.Context) ([]ManagedUserUsage, error)
	SetEnabled(context.Context, string, bool) error
	ResetPassword(context.Context, string, []byte) error
	SetLimits(context.Context, string, contracts.EmployeeResourceLimits) error
	OffboardRetain(context.Context, string) error
	DeleteRetainedEmployee(context.Context, string, string) error
	SetKimiDatasource(context.Context, string, KimiDatasourceGrant) (KimiDatasourceGrant, error)
}

func (s *Server) requireAdmin(next userHandler) userHandler {
	return func(writer http.ResponseWriter, request *http.Request, user store.User) {
		if !user.Admin {
			writeError(writer, http.StatusForbidden, "administrator_required")
			return
		}
		if s.modules.EmployeeManagement == nil {
			writeError(writer, http.StatusServiceUnavailable, "employee_manager_unavailable")
			return
		}
		next(writer, request, user)
	}
}

func (s *Server) adminUsers(writer http.ResponseWriter, request *http.Request, _ store.User) {
	if request.Method == http.MethodGet {
		users, sources, err := s.modules.EmployeeManagement.ListManagedUsers(request.Context())
		if err != nil {
			writeError(writer, http.StatusBadGateway, "employee_manager_failed")
			return
		}
		type overview struct {
			ManagedUser
			Budgets          []quota.ManagedBudget `json:"budgets"`
			QuotaUnavailable bool                  `json:"quota_unavailable,omitempty"`
		}
		rows := make([]overview, 0, len(users))
		management, available := s.modules.Quota.(QuotaManagementPort)
		for _, user := range users {
			row := overview{ManagedUser: user, Budgets: []quota.ManagedBudget{}}
			if available {
				row.Budgets, err = management.ManagedBudgets(request.Context(), user.WindowsSID, s.now())
				row.QuotaUnavailable = err != nil
			} else {
				row.QuotaUnavailable = true
			}
			rows = append(rows, row)
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "users": rows, "kimi_datasource_sources": sources})
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"portal_password"`
	}
	if !decodeJSON(request, &input, 8*1024) || auth.ValidateUsername(input.Username) != nil || auth.ValidatePassword([]byte(input.Password)) != nil {
		writeError(writer, http.StatusBadRequest, "invalid_employee")
		return
	}
	password := []byte(input.Password)
	input.Password = ""
	defer zeroBytes(password)
	job, err := s.modules.EmployeeManagement.StartProvision(request.Context(), input.Username, password)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "employee_provision_failed")
		return
	}
	writeJSON(writer, http.StatusAccepted, map[string]any{"success": true, "job": job})
}

func (s *Server) adminUserJob(writer http.ResponseWriter, request *http.Request, _ store.User) {
	id := request.URL.Query().Get("id")
	if id == "" || len(request.URL.Query()) != 1 {
		writeError(writer, http.StatusBadRequest, "invalid_provision_job")
		return
	}
	job, err := s.modules.EmployeeManagement.ProvisionJob(request.Context(), id)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "employee_manager_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "job": job})
}

func (s *Server) adminUsersUsage(writer http.ResponseWriter, request *http.Request, _ store.User) {
	usage, err := s.modules.EmployeeManagement.ManagedUsersUsage(request.Context())
	if err != nil {
		writeError(writer, http.StatusBadGateway, "employee_manager_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "users": usage})
}

func (s *Server) adminUserAction(writer http.ResponseWriter, request *http.Request, _ store.User) {
	var input struct {
		Username           string                           `json:"username"`
		Password           string                           `json:"portal_password"`
		WindowsPassword    string                           `json:"windows_password"`
		NewWindowsUsername string                           `json:"new_windows_username"`
		Limits             contracts.EmployeeResourceLimits `json:"limits"`
		Confirmation       string                           `json:"confirmation"`
	}
	if !decodeJSON(request, &input, 8*1024) || strings.TrimSpace(input.Username) == "" {
		writeError(writer, http.StatusBadRequest, "invalid_employee_action")
		return
	}
	var err error
	if action := request.PathValue("action"); action == "repair" || action == "restart" || action == "rename-windows" {
		if input.WindowsPassword != "" || (action == "rename-windows" && strings.TrimSpace(input.NewWindowsUsername) == "") {
			writeError(writer, http.StatusBadRequest, "invalid_employee_action")
			return
		}
		job, err := s.modules.EmployeeManagement.StartMaintenance(request.Context(), action, input.Username, input.NewWindowsUsername)
		if err != nil {
			writeError(writer, http.StatusBadGateway, "employee_manager_failed")
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "job": job})
		return
	}
	switch request.PathValue("action") {
	case "disable":
		err = s.modules.EmployeeManagement.SetEnabled(request.Context(), input.Username, false)
	case "enable":
		err = s.modules.EmployeeManagement.SetEnabled(request.Context(), input.Username, true)
	case "reset-password":
		password := []byte(input.Password)
		input.Password = ""
		defer zeroBytes(password)
		if auth.ValidatePassword(password) != nil {
			writeError(writer, http.StatusBadRequest, "invalid_password")
			return
		}
		err = s.modules.EmployeeManagement.ResetPassword(request.Context(), input.Username, password)
	case "set-limits":
		err = s.modules.EmployeeManagement.SetLimits(request.Context(), input.Username, input.Limits)
	case "offboard-retain":
		err = s.modules.EmployeeManagement.OffboardRetain(request.Context(), input.Username)
	case "offboard-delete":
		if input.Confirmation != "DELETE "+input.Username {
			writeError(writer, http.StatusBadRequest, "invalid_delete_confirmation")
			return
		}
		err = s.modules.EmployeeManagement.DeleteRetainedEmployee(request.Context(), input.Username, input.Confirmation)
	default:
		writeError(writer, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		writeError(writer, http.StatusBadGateway, "employee_manager_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"success": true})
}

func (s *Server) adminKimiDatasource(writer http.ResponseWriter, request *http.Request, _ store.User) {
	var input struct {
		Username       string   `json:"username"`
		Enabled        bool     `json:"enabled"`
		AllowedSources []string `json:"allowed_sources"`
		DailyLimit     int      `json:"daily_limit"`
		MonthlyLimit   int      `json:"monthly_limit"`
	}
	if !decodeJSON(request, &input, 16*1024) || input.Username == "" || input.DailyLimit < 0 || input.MonthlyLimit < input.DailyLimit {
		writeError(writer, http.StatusBadRequest, "invalid_kimi_datasource_policy")
		return
	}
	grant, err := s.modules.EmployeeManagement.SetKimiDatasource(request.Context(), input.Username, KimiDatasourceGrant{Enabled: input.Enabled, AllowedSources: input.AllowedSources, DailyLimit: input.DailyLimit, MonthlyLimit: input.MonthlyLimit})
	if err != nil {
		writeError(writer, http.StatusBadGateway, "employee_manager_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "kimi_datasource": grant})
}

func zeroBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
