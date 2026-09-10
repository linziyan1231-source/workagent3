package employeemanager

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
	"workagent3/internal/runtimeapi"
)

func TestResourcesRecheckBusyAndPersistScheduledWake(t *testing.T) {
	now := time.Now().UTC()
	due := now.Add(time.Hour)
	busy := true
	stops, starts := 0, 0
	ended := false
	var runtime *httptest.Server
	runtime = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer runtime-secret" {
			t.Error("wrong runtime credential")
			w.WriteHeader(401)
			return
		}
		if r.Method == "POST" {
			var input struct {
				Draining bool `json:"draining"`
			}
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input.Draining && busy {
				w.WriteHeader(409)
				return
			}
		}
		_ = json.NewEncoder(w).Encode(runtimeActivity{Known: true, NextWakeAt: &due})
	}))
	defer runtime.Close()
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer manager-secret" {
			t.Error("wrong manager credential")
			w.WriteHeader(401)
			return
		}
		if r.Method == "GET" {
			_ = json.NewEncoder(w).Encode([]runtimeapi.RuntimeSnapshot{{SID: "sid", BaseURL: runtime.URL, Token: "runtime-secret", LastAccess: now.Add(-time.Hour)}})
			return
		}
		var input struct {
			Action  string `json:"action"`
			Stopped bool   `json:"stopped"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.Action == "end" {
			ended = true
			if input.Stopped != (stops > 0) {
				t.Error("incorrect stop result")
			}
		}
		w.WriteHeader(204)
	}))
	defer portal.Close()
	journal := filepath.Join(t.TempDir(), "wakes.json")
	start := func(context.Context, string) error { starts++; return nil }
	stop := func(context.Context, string) error { stops++; return nil }
	c, err := NewRuntimeResources(RuntimePolicy{IdleMinutes: 30}, portal.URL, "manager-secret", journal, start, stop)
	if err != nil {
		t.Fatal(err)
	}
	c.now = func() time.Time { return now }
	if err = c.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stops != 0 || !ended {
		t.Fatal("busy runtime stopped or gate not released")
	}
	busy = false
	ended = false
	if err = c.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stops != 1 || !ended {
		t.Fatal("idle runtime not stopped")
	}
	recovered, err := NewRuntimeResources(RuntimePolicy{}, portal.URL, "manager-secret", journal, start, stop)
	if err != nil {
		t.Fatal(err)
	}
	if !recovered.wakeups["sid"].Equal(due) {
		t.Fatal("lost wake time on restart")
	}
	recovered.now = func() time.Time { return due.Add(-20 * time.Second) }
	recovered.start = func(context.Context, string) error { return errors.New("at capacity") }
	_ = recovered.Sweep(context.Background())
	if len(recovered.wakeups) != 1 {
		t.Fatal("failed wake was discarded")
	}
	recovered.start = start
	_ = recovered.Sweep(context.Background())
	if starts != 1 || len(recovered.wakeups) != 0 {
		t.Fatal("wake not completed")
	}
}

func TestResourcesRefuseUnknownActivityAndRequests(t *testing.T) {
	probes, stops := 0, 0
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { probes++; _, _ = w.Write([]byte(`{"active":false}`)) }))
	defer runtime.Close()
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]runtimeapi.RuntimeSnapshot{{SID: "one", BaseURL: runtime.URL, LastAccess: time.Now().Add(-time.Hour), Requests: 1}, {SID: "two", BaseURL: runtime.URL, LastAccess: time.Now().Add(-time.Hour)}})
	}))
	defer portal.Close()
	c, err := NewRuntimeResources(RuntimePolicy{IdleMinutes: 30}, portal.URL, "token", filepath.Join(t.TempDir(), "wakes.json"), func(context.Context, string) error { return nil }, func(context.Context, string) error { stops++; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if probes != 1 || stops != 0 {
		t.Fatalf("probes=%d stops=%d", probes, stops)
	}
}
