package contracts

import "time"

// DollarBudget is a gateway-owned allowance. DSH uses the Codex pool.
type DollarBudget struct {
	SID            string    `json:"sid"`
	Pool           string    `json:"pool"`
	DailyLimitUSD  float64   `json:"dailyLimitUsd"`
	WeeklyLimitUSD float64   `json:"weeklyLimitUsd"`
	DailyUSD       float64   `json:"dailyUsd"`
	WeeklyUSD      float64   `json:"weeklyUsd"`
	DailyResetAt   string    `json:"dailyResetAt"`
	WeeklyResetAt  string    `json:"weeklyResetAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// BillingRate retains the gateway price used to value collected requests.
type BillingRate struct {
	SID     string
	Model   string
	Pool    string
	Mode    string
	Input   float64
	Output  float64
	Cache   float64
	PerCall float64
}

type DollarUsageRow struct {
	SID       string  `json:"sid"`
	Pool      string  `json:"pool"`
	USD       float64 `json:"usd"`
	Requests  int64   `json:"requests"`
	Unpriced  int64   `json:"unpriced"`
	Estimated int64   `json:"estimated"`
}
