package contracts

import "time"

type ManagedEmployee struct {
	Username        string               `json:"username"`
	WindowsUsername string               `json:"windows_username"`
	WindowsSID      string               `json:"windows_sid"`
	Enabled         bool                 `json:"enabled"`
	Offboarded      bool                 `json:"offboarded"`
	CreatedAt       time.Time            `json:"created_at"`
	LastLoginAt     *time.Time           `json:"last_login_at,omitempty"`
	KimiDatasource  *KimiDatasourceGrant `json:"kimi_datasource,omitempty"`
}

type KimiDatasourceGrant struct {
	Enabled        bool     `json:"enabled"`
	AllowedSources []string `json:"allowed_sources"`
	DailyLimit     int      `json:"daily_limit"`
	MonthlyLimit   int      `json:"monthly_limit"`
	DailyUsed      int      `json:"daily_used"`
	MonthlyUsed    int      `json:"monthly_used"`
}

type EmployeeProvisionJob struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	Status       string `json:"status"`
	Percent      int    `json:"percent"`
	Step         string `json:"step"`
	ErrorCode    string `json:"error_code,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

type ManagedEmployeeUsage struct {
	Username                 string      `json:"username"`
	ResourceUsage            *QuotaUsage `json:"resource_usage,omitempty"`
	ResourceUsageUnavailable bool        `json:"resource_usage_unavailable,omitempty"`
}
