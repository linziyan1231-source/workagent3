package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"workagent3/internal/credentialbroker"
)

const managedHarnessProviderCredentialID = "provider-harness"

type providerCredentialResolver interface {
	Metadata(context.Context, string) (credentialbroker.Metadata, error)
	Resolve(context.Context, string) ([]byte, error)
}

type providerCredentialPublisher interface {
	Publish(context.Context) error
}

type providerHealthTester interface {
	Test(context.Context) (providerHealth, error)
}

type providerHealth struct {
	Status    string `json:"status"`
	Message   string `json:"message"`
	ElapsedMS int64  `json:"elapsed_ms"`
}

type harnessProviderCredentialPublisher struct {
	credentials providerCredentialResolver
	target      *url.URL
	token       string
	client      *http.Client
}

func (p *harnessProviderCredentialPublisher) Publish(ctx context.Context) error {
	metadata, err := p.credentials.Metadata(ctx, managedHarnessProviderCredentialID)
	if errors.Is(err, credentialbroker.ErrNotFound) {
		return p.request(ctx, http.MethodDelete, nil)
	}
	if err != nil {
		return err
	}
	if metadata.Kind != credentialbroker.KindProvider {
		return errors.New("managed Provider credential ID has the wrong kind")
	}
	if metadata.State != credentialbroker.StateReady {
		return p.request(ctx, http.MethodDelete, nil)
	}
	secret, err := p.credentials.Resolve(ctx, managedHarnessProviderCredentialID)
	if err != nil {
		return err
	}
	defer clearBytes(secret)
	return p.request(ctx, http.MethodPut, secret)
}

func (p *harnessProviderCredentialPublisher) request(ctx context.Context, method string, secret []byte) error {
	endpoint := p.target.ResolveReference(&url.URL{Path: "/internal/provider-credentials/deepseek-official"})
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(secret))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	request.Header.Set("Content-Type", "application/octet-stream")
	response, err := p.client.Do(request)
	if err != nil {
		return fmt.Errorf("publish managed Provider credential: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("publish managed Provider credential: status %d: %s", response.StatusCode, message)
	}
	return nil
}

func (p *harnessProviderCredentialPublisher) Test(ctx context.Context) (providerHealth, error) {
	endpoint := p.target.ResolveReference(&url.URL{Path: "/internal/providers/deepseek-official/test"})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), nil)
	if err != nil {
		return providerHealth{}, err
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	response, err := p.client.Do(request)
	if err != nil {
		return providerHealth{}, fmt.Errorf("test managed Provider: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return providerHealth{}, fmt.Errorf("test managed Provider: status %d", response.StatusCode)
	}
	var health providerHealth
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4096))
	if decoder.Decode(&health) != nil || (health.Status != "healthy" && health.Status != "unhealthy") || health.Message == "" || len(health.Message) > 256 || health.ElapsedMS < 0 {
		return providerHealth{}, errors.New("test managed Provider: invalid response")
	}
	return health, nil
}

var _ providerCredentialResolver = (*credentialbroker.Store)(nil)
