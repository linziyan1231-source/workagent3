package employeemanager

import (
	"context"
	"strings"

	"workagent3/internal/auth"
	"workagent3/internal/contracts"
)

// The Portal forwards the acting administrator and its request correlation ID
// over these loopback headers so business audit events carry the real actor
// instead of the subsystem name alone.
const (
	correlationHeader = "X-WorkAgent-Correlation-ID"
	actorHeader       = "X-WorkAgent-Actor"
)

type auditScopeKey struct{}

type auditScope struct {
	actor         string
	correlationID string
}

func withAuditScope(ctx context.Context, actor, correlationID string) context.Context {
	return context.WithValue(ctx, auditScopeKey{}, auditScope{actor: strings.TrimSpace(actor), correlationID: strings.TrimSpace(correlationID)})
}

func auditScopeFrom(ctx context.Context) auditScope {
	scope, _ := ctx.Value(auditScopeKey{}).(auditScope)
	return scope
}

// record writes one business audit event for an employee lifecycle action.
// The actor is the operating administrator when the request came through the
// Portal, otherwise the subsystem name; a correlation ID is generated when
// the caller did not propagate one. Recording never fails the action itself.
func (s *Service) record(ctx context.Context, action, target string, operation error, metadata map[string]string) {
	if s.Audit == nil {
		return
	}
	scope := auditScopeFrom(ctx)
	if scope.actor == "" {
		scope.actor = "employee-manager"
	}
	if scope.correlationID == "" {
		generated, err := auth.RandomToken(18)
		if err != nil {
			return
		}
		scope.correlationID = generated
	}
	result := "success"
	if operation != nil {
		result = "failure"
	}
	_, _ = s.Audit.Record(context.WithoutCancel(ctx), contracts.AuditInput{
		Actor: scope.actor, Target: target, Action: action, Result: result, CorrelationID: scope.correlationID, Metadata: metadata,
	})
}
