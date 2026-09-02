package contracts

import "time"

const (
	// ProbeResultPass marks a readiness probe that completed a real request
	// against the deployed model gateway.
	ProbeResultPass = "pass"
	// ProbeResultFail marks a readiness probe that did not complete its real
	// request; failed evidence is reported to the operator but is never
	// accepted into the release readiness record.
	ProbeResultFail = "fail"
)

// ProbeEvidence is the only evidence shape a release readiness probe may
// produce. It carries no credentials, URLs, or free text: Redacted asserts
// the producer kept the record secret-free, and the release controller
// validates every field before accepting it.
type ProbeEvidence struct {
	Engine    string    `json:"engine"`
	Version   string    `json:"version"`
	RunID     string    `json:"run_id"`
	CheckedAt time.Time `json:"checked_at"`
	Result    string    `json:"result"`
	Redacted  bool      `json:"redacted"`
}
