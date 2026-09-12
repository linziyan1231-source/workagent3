package portal

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"strings"

	"workagent3/internal/auth"
	"workagent3/internal/contracts"
)

const correlationHeader = "X-WorkAgent-Correlation-ID"

type auditContextKey struct{}

type auditScope struct {
	correlationID string
	actor         string
	force         bool
	source        map[string]string
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	// 1xx responses other than 101 Switching Protocols are interim, not
	// final: httputil.ReverseProxy relays the runtime's 100 Continue (and
	// any other 1xx) through WriteHeader. Recording one here would drop the
	// real status that follows, and the body write would then implicitly
	// turn the response into a 200. Forward interim statuses untouched.
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(value []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(value)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Flush() {
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func (s *Server) correlatedAudit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		correlationID, err := auth.RandomToken(18)
		if err != nil {
			writeError(writer, http.StatusInternalServerError, "internal_error")
			return
		}
		scope := &auditScope{correlationID: correlationID, actor: "anonymous", source: s.modules.RequestSource.source(request)}
		request = request.WithContext(context.WithValue(request.Context(), auditContextKey{}, scope))
		request.Header.Set(correlationHeader, correlationID)
		writer.Header().Set(correlationHeader, correlationID)
		tracked := &statusWriter{ResponseWriter: writer}
		next.ServeHTTP(tracked, request)
		if s.modules.Audit == nil || (!scope.force && !isWrite(request.Method)) {
			return
		}
		status := tracked.status
		if status == 0 {
			status = http.StatusOK
		}
		_, _ = s.modules.Audit.Record(context.WithoutCancel(request.Context()), contracts.AuditInput{
			Actor: scope.actor, Target: boundedAuditTarget(request.URL.Path), Action: auditAction(request),
			Result: auditResult(status), CorrelationID: correlationID, Metadata: scope.source,
		})
	})
}

func markAudit(request *http.Request, actor string, force bool) {
	if scope, ok := request.Context().Value(auditContextKey{}).(*auditScope); ok {
		if strings.TrimSpace(actor) != "" {
			scope.actor = actor
		}
		scope.force = scope.force || force
	}
}

func CorrelationID(ctx context.Context) string {
	if scope, ok := ctx.Value(auditContextKey{}).(*auditScope); ok {
		return scope.correlationID
	}
	return ""
}

// recordBusinessEvent writes one business audit event from a Portal handler
// or background job (collaboration ACL/ownership, skill market). The actor is
// the acting user or subsystem, the correlation ID ties the event to the HTTP
// request trail when one exists, and recording never fails the operation.
func (s *Server) recordBusinessEvent(ctx context.Context, actor, action, target string, operation error, metadata map[string]string) {
	if s.modules.Audit == nil {
		return
	}
	correlationID := CorrelationID(ctx)
	if correlationID == "" {
		generated, err := auth.RandomToken(18)
		if err != nil {
			return
		}
		correlationID = generated
	}
	result := "success"
	trustedMetadata := map[string]string{}
	for key, value := range metadata {
		trustedMetadata[key] = value
	}
	for _, key := range []string{"client_ip", "peer_ip", "source_kind", "user_agent"} {
		delete(trustedMetadata, key)
	}
	if scope, ok := ctx.Value(auditContextKey{}).(*auditScope); ok {
		for key, value := range scope.source {
			trustedMetadata[key] = value
		}
	} else {
		trustedMetadata["source_kind"] = "background"
	}
	if operation != nil {
		result = "failure"
	}
	_, _ = s.modules.Audit.Record(context.WithoutCancel(ctx), contracts.AuditInput{
		Actor: actor, Target: target, Action: action, Result: result, CorrelationID: correlationID, Metadata: trustedMetadata,
	})
}

func setCorrelationHeader(request *http.Request) {
	if correlationID := CorrelationID(request.Context()); correlationID != "" {
		request.Header.Set(correlationHeader, correlationID)
	}
}

func auditAction(request *http.Request) string {
	pattern := request.Pattern
	if pattern == "" {
		pattern = request.URL.Path
	}
	if strings.HasPrefix(pattern, request.Method+" ") {
		return boundedAuditTarget(pattern)
	}
	return boundedAuditTarget(request.Method + " " + pattern)
}

func auditResult(status int) string {
	if status >= 200 && status < 400 {
		return "success"
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return "denied"
	}
	return "failure"
}

func boundedAuditTarget(value string) string {
	value = strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r == 0 {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if len(value) > 512 {
		value = value[:512]
	}
	return value
}

func isWrite(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}
