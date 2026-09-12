package professionaldb

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const oauthClientID = "17e5f671-d194-4dfb-9706-5516cb48c098"

type credentialManager struct {
	mu              sync.Mutex
	path, oauthHost string
	client          *http.Client
}

type credentialDocument struct {
	AccessToken  string          `json:"access_token"`
	RefreshToken string          `json:"refresh_token"`
	ExpiresAt    json.RawMessage `json:"expires_at,omitempty"`
	Expired      string          `json:"expired,omitempty"`
}

func (m *credentialManager) read() (credentialDocument, map[string]any, error) {
	data, err := os.ReadFile(m.path)
	if err != nil {
		return credentialDocument{}, nil, ErrNeedsAuth
	}
	defer clear(data)
	var document credentialDocument
	var raw map[string]any
	if json.Unmarshal(data, &document) != nil || document.AccessToken == "" || json.Unmarshal(data, &raw) != nil {
		return credentialDocument{}, nil, ErrNeedsAuth
	}
	return document, raw, nil
}

func (m *credentialManager) ready() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	document, _, err := m.read()
	return err == nil && (!credentialExpiresSoon(document, time.Now()) || document.RefreshToken != "")
}

func (m *credentialManager) accessToken(ctx context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	document, raw, err := m.read()
	if err != nil {
		return "", err
	}
	if credentialExpiresSoon(document, time.Now().Add(5*time.Minute)) {
		return m.refreshLocked(ctx, document, raw)
	}
	return document.AccessToken, nil
}

// Concurrent 401 responses share the newly refreshed token. A request retries at
// most once, and keeps the same upstream tool-call ID across that retry.
func (m *credentialManager) refreshRejected(ctx context.Context, rejected string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	document, raw, err := m.read()
	if err != nil {
		return "", err
	}
	if document.AccessToken != rejected && !credentialExpiresSoon(document, time.Now()) {
		return document.AccessToken, nil
	}
	return m.refreshLocked(ctx, document, raw)
}

func (m *credentialManager) refreshLocked(ctx context.Context, document credentialDocument, raw map[string]any) (string, error) {
	if document.RefreshToken == "" {
		return "", ErrNeedsAuth
	}
	form := url.Values{"client_id": {oauthClientID}, "grant_type": {"refresh_token"}, "refresh_token": {document.RefreshToken}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(m.oauthHost, "/")+"/api/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", ErrNeedsAuth
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := m.client.Do(request)
	if err != nil {
		return "", ErrNeedsAuth
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 || response.StatusCode != http.StatusOK {
		return "", ErrNeedsAuth
	}
	defer clear(data)
	var refreshed struct {
		AccessToken  string  `json:"access_token"`
		RefreshToken string  `json:"refresh_token"`
		TokenType    string  `json:"token_type"`
		Scope        string  `json:"scope"`
		ExpiresIn    float64 `json:"expires_in"`
	}
	if json.Unmarshal(data, &refreshed) != nil || refreshed.AccessToken == "" {
		return "", ErrNeedsAuth
	}
	raw["access_token"] = refreshed.AccessToken
	if refreshed.RefreshToken != "" {
		raw["refresh_token"] = refreshed.RefreshToken
	}
	if refreshed.TokenType != "" {
		raw["token_type"] = refreshed.TokenType
	}
	if refreshed.Scope != "" {
		raw["scope"] = refreshed.Scope
	}
	if refreshed.ExpiresIn > 0 {
		expiry := time.Now().Add(time.Duration(refreshed.ExpiresIn * float64(time.Second)))
		raw["expires_at"] = expiry.Unix()
		raw["expired"] = expiry.UTC().Format(time.RFC3339)
	} else {
		delete(raw, "expires_at")
		delete(raw, "expired")
	}
	if err := atomicWriteJSON(m.path, raw); err != nil {
		return "", ErrNeedsAuth
	}
	return refreshed.AccessToken, nil
}

func credentialExpiresSoon(document credentialDocument, threshold time.Time) bool {
	if len(document.ExpiresAt) > 0 && string(document.ExpiresAt) != "null" {
		expires, err := parseCredentialExpiry(document.ExpiresAt)
		return err != nil || !expires.After(threshold)
	}
	if document.Expired != "" {
		expires, err := time.Parse(time.RFC3339, document.Expired)
		return err != nil || !expires.After(threshold)
	}
	return false
}

func parseCredentialExpiry(raw json.RawMessage) (time.Time, error) {
	value := strings.TrimSpace(string(raw))
	if strings.HasPrefix(value, `"`) {
		if err := json.Unmarshal(raw, &value); err != nil {
			return time.Time{}, err
		}
		if stamp, err := time.Parse(time.RFC3339, value); err == nil {
			return stamp, nil
		}
	}
	stamp, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return time.Time{}, errors.New("invalid credential expiry")
	}
	if stamp > 1_000_000_000_000 {
		stamp /= 1000
	}
	seconds := int64(stamp)
	return time.Unix(seconds, int64((stamp-float64(seconds))*float64(time.Second))), nil
}

func atomicWriteJSON(path string, raw map[string]any) error {
	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	defer clear(data)
	temporary, err := os.CreateTemp(filepath.Dir(path), ".professional-database-credential-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if err = temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err = temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	// Go replaces an existing regular file on both Windows and Unix. The
	// temporary file stays in the same private credential directory/volume.
	return os.Rename(temporary.Name(), path)
}
