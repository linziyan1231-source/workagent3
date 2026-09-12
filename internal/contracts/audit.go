package contracts

import "time"

type AuditInput struct {
	Actor         string
	Target        string
	Action        string
	Result        string
	CorrelationID string
	// Metadata carries small, already-redacted event details (for example a
	// model ID or unit count). Producers must never place credentials or key
	// material here; the export path masks sensitive-looking entries as a
	// safety net.
	Metadata map[string]string
}

type AuditEvent struct {
	ID            string            `json:"id"`
	Actor         string            `json:"actor"`
	Target        string            `json:"target"`
	Action        string            `json:"action"`
	Result        string            `json:"result"`
	CorrelationID string            `json:"correlation_id"`
	OccurredAt    time.Time         `json:"occurred_at"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

type AuditQuery struct {
	ClientIP      string
	Actor         string
	Action        string
	Target        string
	CorrelationID string
	// From and To bound OccurredAt inclusively; zero values disable the bound.
	From  time.Time
	To    time.Time
	Limit int
}
