package employeemanager

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"workagent3/internal/runtimeapi"
)

// RuntimePolicy bounds resident employee processes. Zero idle minutes disables
// reclamation; a zero instance limit leaves startup unrestricted.
type RuntimePolicy struct {
	MaxRunningRuntimes int `json:"maxRunningRuntimes"`
	IdleMinutes        int `json:"idleMinutes"`
}

type runtimeActivity struct {
	Known        bool       `json:"known"`
	Active       bool       `json:"active"`
	NextWakeAt   *time.Time `json:"nextWakeAt"`
	LastActiveAt *time.Time `json:"lastActiveAt"`
}

type RuntimeResources struct {
	policy                 RuntimePolicy
	portal, token, journal string
	client                 *http.Client
	now                    func() time.Time
	wakeups                map[string]time.Time
	start, stop            func(context.Context, string) error
}

func NewRuntimeResources(policy RuntimePolicy, portal, token, journal string, start, stop func(context.Context, string) error) (*RuntimeResources, error) {
	if policy.IdleMinutes < 0 || policy.IdleMinutes > 10080 || policy.MaxRunningRuntimes < 0 || policy.MaxRunningRuntimes > 10000 {
		return nil, errors.New("invalid runtime policy")
	}
	c := &RuntimeResources{policy: policy, portal: strings.TrimRight(portal, "/") + "/internal/runtime/control", token: token, journal: journal, client: &http.Client{Timeout: 15 * time.Second}, now: time.Now, wakeups: map[string]time.Time{}, start: start, stop: stop}
	payload, err := os.ReadFile(journal)
	if err == nil {
		if err = json.Unmarshal(payload, &c.wakeups); err != nil {
			return nil, fmt.Errorf("read runtime wakeups: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if c.wakeups == nil {
		c.wakeups = map[string]time.Time{}
	}
	return c, nil
}

func (c *RuntimeResources) request(ctx context.Context, method, address, token string, input, output any) error {
	var body io.Reader
	if input != nil {
		payload, _ := json.Marshal(input)
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, address, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(req)
	if err != nil {
		return errors.New("runtime control unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("runtime control status %d", response.StatusCode)
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output)
	}
	return nil
}

func (c *RuntimeResources) persist() error {
	if err := os.MkdirAll(filepath.Dir(c.journal), 0700); err != nil {
		return err
	}
	payload, _ := json.Marshal(c.wakeups)
	if err := os.WriteFile(c.journal+".tmp", payload, 0600); err != nil {
		return err
	}
	return os.Rename(c.journal+".tmp", c.journal)
}

func (c *RuntimeResources) Run(ctx context.Context) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		if err := c.Sweep(ctx); err != nil && ctx.Err() == nil {
			log.Printf("runtime resource sweep: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (c *RuntimeResources) Sweep(ctx context.Context) error {
	for sid, due := range c.wakeups {
		if due.After(c.now().Add(30 * time.Second)) {
			continue
		}
		if err := c.start(ctx, sid); err != nil {
			log.Printf("scheduled runtime wake deferred for %s", sid)
			continue
		}
		delete(c.wakeups, sid)
		if err := c.persist(); err != nil {
			c.wakeups[sid] = due
			return err
		}
	}
	if c.policy.IdleMinutes == 0 {
		return nil
	}
	var rows []runtimeapi.RuntimeSnapshot
	if err := c.request(ctx, "GET", c.portal, c.token, nil, &rows); err != nil {
		return err
	}
	for _, row := range rows {
		cutoff := c.now().Add(-time.Duration(c.policy.IdleMinutes) * time.Minute)
		if row.Draining || row.Requests > 0 || !row.LastAccess.Before(cutoff) {
			continue
		}
		var activity runtimeActivity
		if err := c.request(ctx, "GET", row.BaseURL+"/v1/activity", row.Token, nil, &activity); err != nil {
			continue
		}
		if !activity.Known || activity.Active || (activity.LastActiveAt != nil && !activity.LastActiveAt.Before(cutoff)) || (activity.NextWakeAt != nil && !activity.NextWakeAt.After(c.now().Add(time.Minute))) {
			continue
		}
		if err := c.reclaim(ctx, row, activity); err != nil {
			log.Printf("runtime reclamation deferred for %s: %v", row.SID, err)
		}
	}
	return nil
}

func (c *RuntimeResources) reclaim(ctx context.Context, row runtimeapi.RuntimeSnapshot, activity runtimeActivity) error {
	// Admission and native activity are checked again after the initial probe.
	if err := c.request(ctx, "POST", c.portal, c.token, map[string]any{"sid": row.SID, "action": "begin", "lastAccess": row.LastAccess}, nil); err != nil {
		return err
	}
	stopped := false
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if !stopped {
			_ = c.request(cleanup, "POST", row.BaseURL+"/v1/activity", row.Token, map[string]bool{"draining": false}, nil)
		}
		_ = c.request(cleanup, "POST", c.portal, c.token, map[string]any{"sid": row.SID, "action": "end", "stopped": stopped}, nil)
	}()
	// Use the second snapshot's wake time: a schedule may change between probes.
	if err := c.request(ctx, "POST", row.BaseURL+"/v1/activity", row.Token, map[string]bool{"draining": true}, &activity); err != nil {
		return err
	}
	if !activity.Known || activity.Active {
		return errors.New("runtime activity changed")
	}
	if activity.NextWakeAt != nil && !activity.NextWakeAt.After(c.now().Add(time.Minute)) {
		return errors.New("automation due shortly")
	}
	old, had := c.wakeups[row.SID]
	if activity.NextWakeAt == nil {
		delete(c.wakeups, row.SID)
	} else {
		c.wakeups[row.SID] = *activity.NextWakeAt
	}
	if err := c.persist(); err != nil {
		if had {
			c.wakeups[row.SID] = old
		} else {
			delete(c.wakeups, row.SID)
		}
		return err
	}
	if err := c.stop(ctx, row.SID); err != nil {
		return err
	}
	stopped = true
	return nil
}
