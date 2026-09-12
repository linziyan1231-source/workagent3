package publishedapps

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"workagent3/internal/winutil"
)

// A snapshot input is removed before its successful HTTP result can be sent.
// A surviving, valid input therefore identifies an interrupted operation, even
// if its worker had already renamed staging into a complete candidate.
func (r *Runner) recoverSnapshots() error {
	apps, err := os.ReadDir(r.config.Root)
	if err != nil {
		return err
	}
	for _, app := range apps {
		if !app.IsDir() {
			continue
		}
		parent := filepath.Join(r.config.Root, app.Name(), "versions")
		entries, err := os.ReadDir(parent)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".input.json") {
				continue
			}
			version := strings.TrimSuffix(entry.Name(), ".input.json")
			directory, err := r.versionPath(app.Name(), version)
			if err != nil {
				continue
			}
			inputPath := filepath.Join(parent, entry.Name())
			raw, err := os.ReadFile(inputPath)
			if err != nil {
				return err
			}
			var input SnapshotInput
			if len(raw) > 32*1024 || json.Unmarshal(raw, &input) != nil || input.Manifest.AppID != app.Name() || input.Manifest.Version != version || filepath.Clean(input.Destination) != directory+".staging" {
				continue
			}
			if err = removeSnapshotArtifact(parent, directory+".staging"); err != nil {
				return err
			}
			if err = removeSnapshotArtifact(parent, directory); err != nil {
				return err
			}
			_ = winutil.DeleteAppContainer(app.Name(), version)
			_ = os.Remove(directory + ".snapshot.log")
			if err = os.Remove(inputPath); err != nil {
				return err
			}
			status := AppStatus{State: "failed", Error: "The previous application snapshot was interrupted. Publish it again.", LastActivity: time.Now()}
			if err = writeWorkerJSON(filepath.Join(r.config.Root, app.Name(), "last-error.json"), status); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *Runner) networkLeasePath(rule winutil.AppNetworkRule) string {
	return filepath.Join(r.config.Root, "network-leases", rule.AppID+"."+rule.Version+".json")
}

// Persist before granting: if UserHost exits, the next instance can revoke the
// previous owner's now-dead processes' WFP rules. Live instances are never in
// networkCleanup; only failed revocations and leases from an earlier host are.
func (r *Runner) authorizeNetwork(ctx context.Context, rule winutil.AppNetworkRule) (string, error) {
	r.networkMu.Lock()
	defer r.networkMu.Unlock()
	path := r.networkLeasePath(rule)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	if err := writeWorkerJSON(path, rule); err != nil {
		return "", err
	}
	identity, err := r.config.AuthorizeNetwork(ctx, rule)
	delete(r.networkCleanup, path)
	return identity, err
}
func (r *Runner) revokeNetwork(rule winutil.AppNetworkRule) {
	r.networkMu.Lock()
	defer r.networkMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	path := r.networkLeasePath(rule)
	if err := r.config.RevokeNetwork(ctx, rule); err != nil {
		r.networkCleanup[path] = rule
		// The pre-grant lease normally exists. Also cover a failed startup that
		// stopped before requesting the grant.
		if os.MkdirAll(filepath.Dir(path), 0700) == nil {
			_ = writeWorkerJSON(path, rule)
		}
	} else {
		delete(r.networkCleanup, path)
		_ = os.Remove(path)
	}
}
func (r *Runner) loadNetworkCleanup() error {
	entries, err := os.ReadDir(filepath.Join(r.config.Root, "network-leases"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(r.config.Root, "network-leases", entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var rule winutil.AppNetworkRule
		if len(raw) > 1024 || json.Unmarshal(raw, &rule) != nil {
			continue
		}
		if _, err = winutil.AppContainerName(rule.AppID, rule.Version); err != nil || r.networkLeasePath(rule) != path {
			continue
		}
		r.networkCleanup[path] = rule
	}
	return nil
}
func (r *Runner) retryNetworkCleanup() {
	r.networkMu.Lock()
	defer r.networkMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for path, rule := range r.networkCleanup {
		if err := r.config.RevokeNetwork(ctx, rule); err != nil {
			return
		}
		delete(r.networkCleanup, path)
		_ = os.Remove(path)
	}
}
