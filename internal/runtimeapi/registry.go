package runtimeapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net"
	"net/url"
	"sync"
	"time"
)

var ErrRuntimeUnavailable = errors.New("employee runtime is unavailable")

type Registration struct {
	SID       string
	BaseURL   string
	Token     string
	ExpiresAt time.Time
}

type Registry struct {
	mu          sync.RWMutex
	now         func() time.Time
	entries     map[string]Registration
	credentials map[string][sha256.Size]byte
}

func NewRegistry() *Registry {
	return &Registry{now: time.Now, entries: make(map[string]Registration), credentials: make(map[string][sha256.Size]byte)}
}

// Authorize installs the per-employee credential used by UserHost to publish
// its loopback endpoint. The raw credential is never retained by Portal.
func (r *Registry) Authorize(sid, credential string) error {
	if sid == "" || credential == "" {
		return errors.New("runtime SID and registration credential are required")
	}
	digest := sha256.Sum256([]byte(credential))
	r.mu.Lock()
	r.credentials[sid] = digest
	r.mu.Unlock()
	return nil
}

func (r *Registry) RegisterAuthorized(credential string, registration Registration) error {
	digest := sha256.Sum256([]byte(credential))
	r.mu.RLock()
	expected, ok := r.credentials[registration.SID]
	r.mu.RUnlock()
	if !ok || subtle.ConstantTimeCompare(digest[:], expected[:]) != 1 {
		return errors.New("runtime registration is not authorized")
	}
	return r.Register(registration)
}

func (r *Registry) Register(registration Registration) error {
	endpoint, err := url.Parse(registration.BaseURL)
	if err != nil || endpoint.Scheme != "http" || endpoint.User != nil || endpoint.Path != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("runtime endpoint must be an HTTP origin")
	}
	host, _, err := net.SplitHostPort(endpoint.Host)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("runtime endpoint must use an explicit loopback IP and port")
	}
	if registration.SID == "" || registration.Token == "" || !registration.ExpiresAt.After(r.now()) {
		return errors.New("runtime registration identity, token, and future expiry are required")
	}
	r.mu.Lock()
	r.entries[registration.SID] = registration
	r.mu.Unlock()
	return nil
}

func (r *Registry) Resolve(_ context.Context, sid string) (Endpoint, error) {
	r.mu.RLock()
	registration, ok := r.entries[sid]
	r.mu.RUnlock()
	if !ok || !registration.ExpiresAt.After(r.now()) {
		return Endpoint{}, ErrRuntimeUnavailable
	}
	endpoint, _ := url.Parse(registration.BaseURL)
	return Endpoint{BaseURL: endpoint, Token: registration.Token}, nil
}

func (r *Registry) Remove(sid, token string) {
	r.mu.Lock()
	if registration, ok := r.entries[sid]; ok && registration.Token == token {
		delete(r.entries, sid)
	}
	r.mu.Unlock()
}
