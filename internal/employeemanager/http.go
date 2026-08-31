package employeemanager

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"

	"workagent3/internal/contracts"
	"workagent3/internal/winutil"
)

func Handler(service *Service, token string) http.Handler {
	mux := http.NewServeMux()
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
	mux.HandleFunc("POST /v1/users/{action}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Username           string                        `json:"username"`
			Password           string                        `json:"portal_password"`
			WindowsPassword    string                        `json:"windows_password"`
			NewWindowsUsername string                        `json:"new_windows_username"`
			Grant              contracts.KimiDatasourceGrant `json:"grant"`
			Limits             winutil.JobLimits             `json:"limits"`
		}
		if !decode(r, &input) {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		var result any = map[string]bool{"success": true}
		var err error
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
		case "repair":
			password := []byte(input.WindowsPassword)
			input.WindowsPassword = ""
			defer zero(password)
			err = service.Repair(r.Context(), input.Username, password)
		case "rename-windows":
			password := []byte(input.WindowsPassword)
			input.WindowsPassword = ""
			defer zero(password)
			err = service.RenameWindowsAccount(r.Context(), input.Username, input.NewWindowsUsername, password)
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
