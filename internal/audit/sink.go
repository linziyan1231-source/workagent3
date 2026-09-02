package audit

import (
	"context"

	"workagent3/internal/auth"
	"workagent3/internal/contracts"
)

// Sink is the minimal business-event audit port. Unlike the Portal HTTP
// middleware (which audits requests), business modules write domain events
// through this interface. *Store implements it. The action vocabulary lives
// in actions.go.
type Sink interface {
	Record(context.Context, contracts.AuditInput) (contracts.AuditEvent, error)
}

var _ Sink = (*Store)(nil)

// RecordCLI writes one terminal business event for an operator-driven CLI
// action (employee-manager, backup-manager, release-manager). The actor is
// the subsystem name, the correlation ID is generated per invocation, and
// recording never fails the action itself.
func RecordCLI(ctx context.Context, sink Sink, actor, action, target string, operation error, metadata map[string]string) {
	if sink == nil || action == "" {
		return
	}
	correlationID, err := auth.RandomToken(18)
	if err != nil {
		return
	}
	result := "success"
	if operation != nil {
		result = "failure"
	}
	_, _ = sink.Record(context.WithoutCancel(ctx), contracts.AuditInput{
		Actor: actor, Target: target, Action: action, Result: result, CorrelationID: correlationID, Metadata: metadata,
	})
}
