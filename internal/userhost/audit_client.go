package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// auditClient reports UserHost business events (Skill/MCP lifecycle, MCP
// OAuth) to the Portal's loopback runtime audit endpoint. Reporting is
// best-effort: failures never fail the user action, matching the audit policy
// everywhere else.
type auditClient struct {
	endpoint   string
	credential string
	sid        string
	client     *http.Client
}

func newAuditClient(portalURL, credential, sid string) (*auditClient, error) {
	base, err := url.Parse(portalURL)
	if err != nil || base.Scheme != "http" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("Portal audit URL must be a loopback HTTP origin")
	}
	host, _, err := net.SplitHostPort(base.Host)
	if err != nil || !net.ParseIP(host).IsLoopback() || credential == "" || sid == "" {
		return nil, errors.New("Portal audit URL, credential and SID are required")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/internal/runtime/audit"
	return &auditClient{endpoint: base.String(), credential: credential, sid: sid, client: &http.Client{Timeout: 5 * time.Second}}, nil
}

// Record sends one event. The Portal forces the actor to this runtime's SID;
// an empty correlation ID is replaced server-side.
func (c *auditClient) Record(ctx context.Context, action, target, result, correlationID string, metadata map[string]string) {
	if c == nil {
		return
	}
	body, err := json.Marshal(map[string]any{
		"sid": c.sid, "target": target, "action": action, "result": result,
		"correlation_id": correlationID, "metadata": metadata,
	})
	if err != nil {
		return
	}
	request, err := http.NewRequestWithContext(context.WithoutCancel(ctx), http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	request.Header.Set("Authorization", "Bearer "+c.credential)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return
	}
	response.Body.Close()
}

// auditResult maps an operation error to the audit result vocabulary.
func auditResult(operation error) string {
	if operation != nil {
		return "failure"
	}
	return "success"
}

// requestCorrelationID reads the Portal-propagated correlation ID so runtime
// events join the initiating request's audit trail.
func requestCorrelationID(request *http.Request) string {
	return strings.TrimSpace(request.Header.Get("X-WorkAgent-Correlation-ID"))
}
