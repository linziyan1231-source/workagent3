package contracts

import "time"

type AuditInput struct {
	Actor         string
	Target        string
	Action        string
	Result        string
	CorrelationID string
}

type AuditEvent struct {
	ID            string    `json:"id"`
	Actor         string    `json:"actor"`
	Target        string    `json:"target"`
	Action        string    `json:"action"`
	Result        string    `json:"result"`
	CorrelationID string    `json:"correlation_id"`
	OccurredAt    time.Time `json:"occurred_at"`
}

type AuditQuery struct {
	Actor         string
	CorrelationID string
	Limit         int
}
