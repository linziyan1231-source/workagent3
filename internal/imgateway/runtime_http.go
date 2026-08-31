package imgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type HTTPRuntimeDelivery struct {
	endpoint *url.URL
	token    string
	client   *http.Client
}

func NewHTTPRuntimeDelivery(rawURL, token string) (*HTTPRuntimeDelivery, error) {
	endpoint, err := url.Parse(strings.TrimRight(rawURL, "/"))
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && loopbackHost(endpoint.Hostname()))) {
		return nil, errors.New("IM delivery endpoint must use HTTPS or loopback HTTP")
	}
	if len(token) < 32 {
		return nil, errors.New("IM delivery token must contain at least 32 bytes")
	}
	return &HTTPRuntimeDelivery{endpoint: endpoint, token: token, client: &http.Client{Timeout: 2 * time.Minute}}, nil
}

func (d *HTTPRuntimeDelivery) Deliver(ctx context.Context, delivery RuntimeDelivery) (DeliveryReceipt, error) {
	body, err := json.Marshal(delivery)
	if err != nil {
		return DeliveryReceipt{}, err
	}
	target := d.endpoint.ResolveReference(&url.URL{Path: "/internal/im/deliver"})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return DeliveryReceipt{}, err
	}
	request.Header.Set("Authorization", "Bearer "+d.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := d.client.Do(request)
	if err != nil {
		return DeliveryReceipt{}, fmt.Errorf("call Portal IM delivery: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return DeliveryReceipt{}, fmt.Errorf("Portal IM delivery returned HTTP %d", response.StatusCode)
	}
	var receipt DeliveryReceipt
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&receipt); err != nil {
		return DeliveryReceipt{}, fmt.Errorf("decode Portal IM delivery receipt: %w", err)
	}
	return receipt, nil
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
