package contracts

import "time"

// GatewayUsageRecord is one per-request usage row drained from the model
// gateway (CLIProxyAPI /v0/management/usage-queue). The plaintext downstream
// key the record carried is never part of this type: the drain maps api_key
// to the owning SID and discards the plaintext before the record exists.
type GatewayUsageRecord struct {
	RequestID       string
	SID             string
	Provider        string
	Model           string
	Alias           string
	Endpoint        string
	AuthType        string
	Failed          bool
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
	CachedTokens    int64
	TotalTokens     int64
	OccurredAt      time.Time
}

// GatewayModelUsage aggregates authoritative tokens for one gateway-reported
// model over the current daily window.
type GatewayModelUsage struct {
	Model       string `json:"model"`
	TotalTokens int64  `json:"totalTokens"`
	Requests    int64  `json:"requests"`
}

// GatewayUsage is the authoritative daily and weekly token usage for one
// employee, summed from drained gateway records (failed requests excluded).
type GatewayUsage struct {
	DailyPeriodKey  string              `json:"dailyPeriodKey"`
	DailyTokens     int64               `json:"dailyTokens"`
	WeeklyPeriodKey string              `json:"weeklyPeriodKey"`
	WeeklyTokens    int64               `json:"weeklyTokens"`
	Models          []GatewayModelUsage `json:"models"`
}
