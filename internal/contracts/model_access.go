package contracts

import "errors"

var ErrQuotaNotConfigured = errors.New("quota budget is not configured")

type ModelHealth string

const (
	ModelHealthy     ModelHealth = "healthy"
	ModelDegraded    ModelHealth = "degraded"
	ModelUnavailable ModelHealth = "unavailable"
	ModelUnknown     ModelHealth = "unknown"
)

type Model struct {
	ID                    string      `json:"id"`
	ProviderID            string      `json:"providerId"`
	DisplayName           string      `json:"displayName"`
	Aliases               []string    `json:"aliases"`
	ContextWindow         int64       `json:"contextWindow"`
	InputPricePerMillion  *float64    `json:"inputPricePerMillion"`
	OutputPricePerMillion *float64    `json:"outputPricePerMillion"`
	Health                ModelHealth `json:"health"`
}

type ModelAuthorization struct {
	ModelID    string `json:"modelId"`
	Authorized bool   `json:"authorized"`
	Reason     string `json:"reason,omitempty"`
}

type AuthorizedModel struct {
	Model
	Authorization ModelAuthorization `json:"authorization"`
}

type QuotaUsage struct {
	LimitUnits    int64  `json:"limitUnits"`
	ConsumedUnits int64  `json:"consumedUnits"`
	ReservedUnits int64  `json:"reservedUnits"`
	Period        string `json:"period"`
	PeriodKey     string `json:"periodKey"`
}
