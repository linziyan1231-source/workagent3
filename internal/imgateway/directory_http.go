package imgateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type EmployeeDirectoryPort interface {
	Exists(context.Context, string) (bool, error)
}

type HTTPEmployeeDirectory struct {
	endpoint *url.URL
	token    string
	client   *http.Client
}

func NewHTTPEmployeeDirectory(rawURL, token string) (*HTTPEmployeeDirectory, error) {
	endpoint, err := url.Parse(strings.TrimRight(rawURL, "/"))
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && loopbackHost(endpoint.Hostname()))) {
		return nil, errors.New("employee directory endpoint must use HTTPS or loopback HTTP")
	}
	if len(token) < 32 {
		return nil, errors.New("employee directory token must contain at least 32 bytes")
	}
	return &HTTPEmployeeDirectory{endpoint: endpoint, token: token, client: &http.Client{Timeout: 15 * time.Second}}, nil
}

func (d *HTTPEmployeeDirectory) Exists(ctx context.Context, sid string) (bool, error) {
	target := d.endpoint.ResolveReference(&url.URL{Path: "/internal/im/employees/" + url.PathEscape(sid)})
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	request.Header.Set("Authorization", "Bearer "+d.token)
	response, err := d.client.Do(request)
	if err != nil {
		return false, fmt.Errorf("query Portal employee directory: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	if response.StatusCode == http.StatusNoContent {
		return true, nil
	}
	if response.StatusCode == http.StatusNotFound {
		return false, nil
	}
	return false, fmt.Errorf("Portal employee directory returned HTTP %d", response.StatusCode)
}
