package runtimeapi

import (
	"context"
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
	mu      sync.RWMutex
	now     func() time.Time
	entries map[string]Registration
}

func NewRegistry() *Registry {
	return &Registry{now: time.Now, entries: make(map[string]Registration)}
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
