package runtimeapi

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type RuntimeSnapshot struct {
	SID        string    `json:"sid"`
	BaseURL    string    `json:"baseURL"`
	Token      string    `json:"token"`
	LastAccess time.Time `json:"lastAccess"`
	Requests   int       `json:"requests"`
	Draining   bool      `json:"draining"`
}

func (r *Registry) Snapshots() []RuntimeSnapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rows := []RuntimeSnapshot{}
	for sid, entry := range r.entries {
		if entry.ExpiresAt.After(r.now()) {
			rows = append(rows, RuntimeSnapshot{sid, entry.BaseURL, entry.Token, r.lastAccess[sid], r.requests[sid], r.draining[sid].After(r.now())})
		}
	}
	return rows
}
func (r *Registry) BeginDrain(sid string, lastAccess time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.draining[sid].After(r.now()) || r.requests[sid] > 0 || !r.lastAccess[sid].Equal(lastAccess) || r.starting[sid] != nil {
		return false
	}
	if _, ok := r.entries[sid]; !ok {
		return false
	}
	r.draining[sid] = r.now().Add(2 * time.Minute)
	return true
}
func (r *Registry) EndDrain(sid string, stopped bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.draining, sid)
	if stopped {
		delete(r.entries, sid)
	}
}

// Endpoint credentials travel only between the loopback Portal and SYSTEM
// manager. This handler is never mounted on the authenticated browser API.
func ControlHandler(registry *Registry, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provided, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !IsLoopbackRequest(r) || token == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(registry.Snapshots())
			return
		}
		var input struct {
			SID        string    `json:"sid"`
			LastAccess time.Time `json:"lastAccess"`
			Action     string    `json:"action"`
			Stopped    bool      `json:"stopped"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		switch input.Action {
		case "begin":
			if !registry.BeginDrain(input.SID, input.LastAccess) {
				http.Error(w, "runtime_busy", 409)
				return
			}
		case "end":
			registry.EndDrain(input.SID, input.Stopped)
		default:
			http.Error(w, "invalid action", 400)
			return
		}
		w.WriteHeader(204)
	})
}
