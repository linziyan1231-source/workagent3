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
	lastAccess  map[string]time.Time
	requests    map[string]int
	draining    map[string]time.Time
	starter     func(context.Context, string) error
	starting    map[string]*runtimeStart
}
type runtimeStart struct {
	done chan struct{}
	err  error
}

func NewRegistry() *Registry {
	return &Registry{now: time.Now, entries: make(map[string]Registration), credentials: make(map[string][sha256.Size]byte), lastAccess: make(map[string]time.Time), requests: make(map[string]int), draining: make(map[string]time.Time), starting: make(map[string]*runtimeStart)}
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

func (r *Registry) AuthorizeRuntime(_ context.Context, sid, credential string) error {
	return r.Authorize(sid, credential)
}

func (r *Registry) RuntimeRegistrationAuthorized(_ context.Context, sid, credential string) bool {
	return r.authorize(sid, credential) == nil
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
	if _, ok := r.entries[registration.SID]; !ok {
		r.lastAccess[registration.SID] = r.now()
	}
	r.entries[registration.SID] = registration
	r.mu.Unlock()
	return nil
}

func (r *Registry) Lookup(sid string) (Endpoint, error) {
	r.mu.RLock()
	registration, ok := r.entries[sid]
	r.mu.RUnlock()
	if !ok || !registration.ExpiresAt.After(r.now()) {
		return Endpoint{}, ErrRuntimeUnavailable
	}
	endpoint, _ := url.Parse(registration.BaseURL)
	return Endpoint{BaseURL: endpoint, Token: registration.Token}, nil
}

func (r *Registry) SetStarter(start func(context.Context, string) error) { r.starter = start }
func (r *Registry) Resolve(ctx context.Context, sid string) (Endpoint, error) {
	r.mu.Lock()
	if r.draining[sid].After(r.now()) {
		r.mu.Unlock()
		return Endpoint{}, ErrRuntimeUnavailable
	}
	r.lastAccess[sid] = r.now()
	r.mu.Unlock()
	endpoint, err := r.Lookup(sid)
	if err == nil || r.starter == nil {
		return endpoint, err
	}
	r.mu.Lock()
	if current, ok := r.entries[sid]; ok && current.ExpiresAt.After(r.now()) {
		r.mu.Unlock()
		return r.Lookup(sid)
	}
	pending := r.starting[sid]
	if pending == nil {
		pending = &runtimeStart{done: make(chan struct{})}
		r.starting[sid] = pending
		go func() {
			startCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			pending.err = r.starter(startCtx, sid)
			r.mu.Lock()
			delete(r.starting, sid)
			close(pending.done)
			r.mu.Unlock()
		}()
	}
	r.mu.Unlock()
	select {
	case <-ctx.Done():
		return Endpoint{}, ctx.Err()
	case <-pending.done:
		if pending.err != nil {
			return Endpoint{}, pending.err
		}
		return r.Lookup(sid)
	}
}

func (r *Registry) BeginRequest(sid string) (func(), error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.draining[sid].After(r.now()) {
		return nil, ErrRuntimeUnavailable
	}
	r.requests[sid]++
	r.lastAccess[sid] = r.now()
	return func() { r.mu.Lock(); r.requests[sid]--; r.lastAccess[sid] = r.now(); r.mu.Unlock() }, nil
}

func (r *Registry) Remove(sid, token string) {
	r.mu.Lock()
	if registration, ok := r.entries[sid]; ok && registration.Token == token {
		delete(r.entries, sid)
	}
	r.mu.Unlock()
}
