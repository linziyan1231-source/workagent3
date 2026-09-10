package employeemanager

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"

	"workagent3/internal/contracts"
	"workagent3/internal/userhost"
)

func Handler(service *Service, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/runtime/ensure",func(w http.ResponseWriter,r *http.Request){
		var input struct{SID string `json:"sid"`}
		if !decode(r,&input){http.Error(w,"invalid request",400);return}
		err:=service.EnsureRuntime(r.Context(),input.SID);respond(w,map[string]bool{"started":err==nil},err)
	})
	mux.HandleFunc("GET /v1/storage/{sid}", func(w http.ResponseWriter, r *http.Request) {
		value, err := service.StorageUsage(r.Context(), r.PathValue("sid"), nil)
		respond(w, value, err)
	})
	mux.HandleFunc("PUT /v1/storage/{sid}", func(w http.ResponseWriter, r *http.Request) {
		var input contracts.StorageLimits
		if !decode(r, &input) {
			http.Error(w, "invalid storage limits", http.StatusBadRequest)
			return
		}
		value, err := service.StorageUsage(r.Context(), r.PathValue("sid"), &input)
		respond(w, value, err)
	})
	mux.HandleFunc("GET /v1/users", func(w http.ResponseWriter, r *http.Request) {
		users, sources, err := service.ListManagedUsers(r.Context())
		respond(w, map[string]any{"users": users, "kimi_datasource_sources": sources}, err)
	})
	mux.HandleFunc("POST /v1/users", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Username string `json:"username"`
			Password string `json:"portal_password"`
		}
		if !decode(r, &input) {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		password := []byte(input.Password)
		input.Password = ""
		defer zero(password)
		job, err := service.StartProvision(r.Context(), input.Username, password)
		respond(w, map[string]any{"job": job}, err)
	})
	mux.HandleFunc("GET /v1/jobs", func(w http.ResponseWriter, r *http.Request) {
		job, err := service.ProvisionJob(r.Context(), r.URL.Query().Get("id"))
		respond(w, map[string]any{"job": job}, err)
	})
	mux.HandleFunc("GET /v1/users/usage", func(w http.ResponseWriter, r *http.Request) {
		users, err := service.ManagedUsersUsage(r.Context())
		respond(w, map[string]any{"users": users}, err)
	})
	mux.HandleFunc("PUT /v1/shared-projects/{id}", func(w http.ResponseWriter, r *http.Request) {
		var input userhost.SharedProjectRequest
		if !decode(r, &input) {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		err := service.ApplySharedProjectTransfer(r.Context(), r.PathValue("id"), input)
		respond(w, map[string]bool{"success": true}, err)
	})
	mux.HandleFunc("POST /v1/users/{action}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Username           string                           `json:"username"`
			Password           string                           `json:"portal_password"`
			WindowsPassword    string                           `json:"windows_password"`
			NewWindowsUsername string                           `json:"new_windows_username"`
			Confirmation       string                           `json:"confirmation"`
			Grant              contracts.KimiDatasourceGrant    `json:"grant"`
			Limits             contracts.EmployeeResourceLimits `json:"limits"`
		}
		if !decode(r, &input) {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		var result any = map[string]bool{"success": true}
		var err error
		if action := r.PathValue("action"); action == "repair" || action == "restart" || action == "rename-windows" {
			if input.WindowsPassword != "" {
				http.Error(w, "Windows credentials are managed by the service", http.StatusBadRequest)
				return
			}
			job, err := service.StartMaintenance(r.Context(), action, input.Username, input.NewWindowsUsername)
			respond(w, map[string]any{"job": job}, err)
			return
		}
		switch r.PathValue("action") {
		case "enable":
			err = service.SetEnabled(r.Context(), input.Username, true)
		case "disable":
			err = service.SetEnabled(r.Context(), input.Username, false)
		case "reset-password":
			password := []byte(input.Password)
			input.Password = ""
			defer zero(password)
			err = service.ResetPassword(r.Context(), input.Username, password)
		case "set-limits":
			err = service.SetLimits(r.Context(), input.Username, input.Limits)
		case "offboard-retain":
			err = service.OffboardRetain(r.Context(), input.Username)
		case "offboard-delete":
			err = service.DeleteRetainedEmployee(r.Context(), input.Username, input.Confirmation)
		case "kimi-datasource":
			result, err = service.SetKimiDatasource(r.Context(), input.Username, input.Grant)
		default:
			http.NotFound(w, r)
			return
		}
		respond(w, result, err)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected, actual := []byte("Bearer "+token), []byte(r.Header.Get("Authorization"))
		if len(expected) != len(actual) || subtle.ConstantTimeCompare(expected, actual) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// Carry the Portal-propagated actor and correlation ID into the
		// request context so business audit events attribute the real admin.
		r = r.WithContext(withAuditScope(r.Context(), r.Header.Get(actorHeader), r.Header.Get(correlationHeader)))
		mux.ServeHTTP(w, r)
	})
}

func decode(r *http.Request, value any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	return decoder.Decode(value) == nil && decoder.Decode(&struct{}{}) == io.EOF
}
func respond(w http.ResponseWriter, value any, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	json.NewEncoder(w).Encode(value)
}
