package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"workagent3/internal/runtimeapi"
)

type LeaseReporter interface {
	Publish(context.Context, runtimeapi.Registration) error
	Remove(context.Context, runtimeapi.Registration) error
}

type HTTPLeaseReporter struct {
	endpoint   string
	credential string
	client     *http.Client
}

func NewHTTPLeaseReporter(portalURL, credential string) (*HTTPLeaseReporter, error) {
	base, err := url.Parse(portalURL)
	if err != nil || base.Scheme != "http" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("Portal registration URL must be a loopback HTTP origin")
	}
	host, _, err := net.SplitHostPort(base.Host)
	if err != nil || !net.ParseIP(host).IsLoopback() || credential == "" {
		return nil, errors.New("Portal registration URL and credential are required")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/internal/runtime/lease"
	return &HTTPLeaseReporter{endpoint: base.String(), credential: credential, client: &http.Client{Timeout: 5 * time.Second}}, nil
}

func (r *HTTPLeaseReporter) Publish(ctx context.Context, registration runtimeapi.Registration) error {
	return r.send(ctx, http.MethodPut, registration)
}

func (r *HTTPLeaseReporter) Remove(ctx context.Context, registration runtimeapi.Registration) error {
	return r.send(ctx, http.MethodDelete, registration)
}

func (r *HTTPLeaseReporter) send(ctx context.Context, method string, registration runtimeapi.Registration) error {
	body, err := json.Marshal(runtimeapi.LeaseRequest{SID: registration.SID, BaseURL: registration.BaseURL, Token: registration.Token})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, method, r.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+r.credential)
	request.Header.Set("Content-Type", "application/json")
	response, err := r.client.Do(request)
	if err != nil {
		return fmt.Errorf("report runtime lease: %w", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("report runtime lease: Portal returned %s", response.Status)
	}
	return nil
}
