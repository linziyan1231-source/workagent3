package contracts

// ProfessionalDatabaseStatus is scoped to the authenticated employee. Limits
// are calendar-period totals, not a shared allowance or a lifetime balance.
type ProfessionalDatabaseStatus struct {
	KimiDatasourceGrant
	Configured       bool   `json:"configured"`
	UpstreamReady    bool   `json:"upstream_ready"`
	DailyRemaining   int    `json:"daily_remaining"`
	MonthlyRemaining int    `json:"monthly_remaining"`
	Timezone         string `json:"timezone"`
	CountingRule     string `json:"counting_rule"`
}

// ProfessionalDatabaseConnection is only carried over protected service APIs.
// It must never be returned in a market bundle or a browser response.
type ProfessionalDatabaseConnection struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
}
