package userhost

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"workagent3/internal/publishedapps"
	"workagent3/internal/winutil"
)

type publishedApplicationGateway struct {
	runner                           *publishedapps.Runner
	workspaceRoot, sharedBase, token string
	platformURL, platformCredential  string
	sid                              string
	target                           *url.URL
	client                           *http.Client
}

func (s *Supervisor) attachPublishedApps(gateway *runtimeGateway, target *url.URL, token string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	networkEndpoint := strings.TrimRight(s.config.PlatformURL, "/") + "/internal/runtime/published-apps/network"
	network := func(ctx context.Context, rule winutil.AppNetworkRule, operation string) (string, error) {
		raw, _ := json.Marshal(struct {
			SID       string `json:"sid"`
			Operation string `json:"operation,omitempty"`
			winutil.AppNetworkRule
		}{s.config.SID, operation, rule})
		request, err := http.NewRequestWithContext(ctx, "POST", networkEndpoint, bytes.NewReader(raw))
		if err != nil {
			return "", err
		}
		request.Header.Set("Authorization", "Bearer "+s.config.PlatformCredential)
		request.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{Proxy: nil}}
		defer client.CloseIdleConnections()
		response, err := client.Do(request)
		if err != nil {
			return "", err
		}
		defer response.Body.Close()
		var result struct {
			PackageSID string `json:"packageSid"`
		}
		if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result) != nil {
			return "", errors.New("application network authorization failed")
		}
		return result.PackageSID, nil
	}
	runner, err := publishedapps.NewRunner(publishedapps.RunnerConfig{Root: filepath.Join(s.config.DataRoot, "published-apps"), OwnerSID: s.config.SID, WorkerCommand: executable, NodeCommand: s.config.Command, PythonCommand: s.config.PublishedPythonCommand, OwnerJob: s.job, AuthorizeNetwork: func(ctx context.Context, rule winutil.AppNetworkRule) (string, error) {
		return network(ctx, rule, "enable")
	}, RevokeNetwork: func(ctx context.Context, rule winutil.AppNetworkRule) error {
		_, err := network(ctx, rule, "disable")
		return err
	}})
	if err != nil {
		return err
	}
	feature := &publishedApplicationGateway{runner: runner, workspaceRoot: filepath.Join(s.config.DataRoot, "workspace"), sharedBase: filepath.Dir(s.config.DataRoot), platformURL: strings.TrimRight(s.config.PlatformURL, "/"), platformCredential: s.config.PlatformCredential, sid: s.config.SID, target: target, token: token, client: &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}}}
	old := gateway.server.Handler
	gateway.server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/app-publishing" || r.URL.Path == "/v1/app-publishing/publish" {
			provided, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || subtle.ConstantTimeCompare([]byte(provided), []byte(gateway.butlerToken)) != 1 || !allowedButlerRequest(r) {
				writeRuntimeError(w, 403, "butler_operation_not_allowed")
				return
			}
			feature.agentProxy(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v1/published-apps/") || r.URL.Path == "/v1/activity" {
			provided, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
				writeRuntimeError(w, 401, "runtime_authentication_required")
				return
			}
			if r.URL.Path == "/v1/activity" {
				if runner.Activity() {
					writeRuntimeJSON(w, 200, map[string]any{"known": true, "active": true, "lastActiveAt": time.Now(), "draining": false})
					return
				}
				old.ServeHTTP(w, r)
				return
			}
			feature.ServeHTTP(w, r)
			return
		}
		old.ServeHTTP(w, r)
	})
	gateway.closePublishedApps = func() { runner.Close(); feature.client.CloseIdleConnections() }
	return nil
}

// agentProxy forwards the agent-facing publish tool calls to Portal's
// internal runtime endpoints, always scoped to this employee's SID.
func (g *publishedApplicationGateway) agentProxy(w http.ResponseWriter, r *http.Request) {
	var body []byte
	if r.URL.Path == "/v1/app-publishing/publish" {
		if r.Method != "POST" {
			writeRuntimeError(w, 405, "method_not_allowed")
			return
		}
		var input map[string]any
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&input) != nil {
			writeRuntimeError(w, 400, "invalid_application")
			return
		}
		delete(input, "sid")
		input["sid"] = g.sid
		body, _ = json.Marshal(input)
	} else {
		if r.Method != "GET" {
			writeRuntimeError(w, 405, "method_not_allowed")
			return
		}
		body, _ = json.Marshal(map[string]string{"sid": g.sid})
	}
	operation := "list"
	if r.URL.Path == "/v1/app-publishing/publish" {
		operation = "publish"
	}
	// Publishing snapshots the workspace through Portal, which can take minutes.
	ctx, cancel := context.WithTimeout(r.Context(), 150*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, "POST", g.platformURL+"/internal/runtime/published-apps/"+operation, bytes.NewReader(body))
	if err != nil {
		writeRuntimeError(w, 500, "internal_error")
		return
	}
	request.Header.Set("Authorization", "Bearer "+g.platformCredential)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		writeRuntimeError(w, 502, "application_platform_unavailable")
		return
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		writeRuntimeError(w, 502, "application_platform_unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(payload)
}

func (g *publishedApplicationGateway) source(ctx context.Context, id string) (string, error) {
	if strings.HasPrefix(id, "shared:") {
		project := strings.TrimPrefix(id, "shared:")
		if !sharedProjectIDPattern.MatchString(project) {
			return "", publishedapps.ErrInvalid
		}
		return resolveSharedSessionRoot(g.sharedBase, project)
	}
	if !officePreviewWorkspaceID.MatchString(id) {
		return "", publishedapps.ErrInvalid
	}
	if id == "default" {
		root := filepath.Join(g.workspaceRoot, ".workagent-unassigned")
		if err := requireNormalDirectory(root); err != nil {
			return "", err
		}
		return root, nil
	}
	endpoint := *g.target
	endpoint.Path = "/v1/workspaces"
	request, _ := http.NewRequestWithContext(ctx, "GET", endpoint.String(), nil)
	request.Header.Set("Authorization", "Bearer "+g.token)
	response, err := g.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", errors.New("workspace authorization failed")
	}
	var workspaces []struct {
		ID        string `json:"id"`
		Directory string `json:"directory"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&workspaces) != nil {
		return "", errors.New("invalid workspace catalog")
	}
	for _, workspace := range workspaces {
		if workspace.ID == id {
			directory := workspace.Directory
			if directory == "" {
				directory = id
			}
			if !validSharedFileName(directory) || strings.TrimSpace(directory) != directory || strings.HasSuffix(directory, ".") || directory == ".workagent" || directory == ".workagent-trash" {
				return "", publishedapps.ErrInvalid
			}
			root := filepath.Join(g.workspaceRoot, directory)
			if err = requireNormalDirectory(root); err != nil {
				return "", err
			}
			return root, nil
		}
	}
	return "", errors.New("workspace not found")
}
func (g *publishedApplicationGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	pieces := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/v1/published-apps/"), "/", 3)
	if len(pieces) < 2 {
		writeRuntimeError(w, 404, "application_not_found")
		return
	}
	id, action := pieces[0], pieces[1]
	switch action {
	case "versions":
		if r.Method != "POST" || len(pieces) != 2 {
			writeRuntimeError(w, 405, "method_not_allowed")
			return
		}
		var input struct {
			WorkspaceID    string   `json:"workspaceId"`
			Kind           string   `json:"kind"`
			Entry          string   `json:"entry"`
			AllowedOrigins []string `json:"allowedOrigins"`
			Version        string   `json:"version"`
			Preview        bool     `json:"preview"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			writeRuntimeError(w, 400, "invalid_application_snapshot")
			return
		}
		root, err := g.source(r.Context(), input.WorkspaceID)
		if err != nil {
			writeRuntimeError(w, 403, "application_workspace_unavailable")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		manifest, err := g.runner.Snapshot(ctx, id, root, input.Entry, publishedapps.Manifest{Version: input.Version, Kind: input.Kind, Entry: input.Entry, AllowedOrigins: input.AllowedOrigins, Preview: input.Preview})
		if err != nil {
			writeRuntimeError(w, 422, "application_snapshot_or_start_failed")
			return
		}
		writeRuntimeJSON(w, 200, manifest)
	case "stop":
		if r.Method != "POST" {
			writeRuntimeError(w, 405, "method_not_allowed")
			return
		}
		g.runner.Stop(id)
		writeRuntimeJSON(w, 200, map[string]bool{"ok": true})
	case "status":
		if r.Method != "GET" {
			writeRuntimeError(w, 405, "method_not_allowed")
			return
		}
		writeRuntimeJSON(w, 200, g.runner.Status(id, r.URL.Query().Get("version")))
	case "content":
		version := r.Header.Get("X-WorkAgent-App-Version")
		preview := r.Header.Get("X-WorkAgent-App-Preview") == "true" || r.Header.Get("X-WorkAgent-App-Preview") == "1"
		target, release, err := g.runner.Acquire(r.Context(), id, version, preview)
		if err != nil {
			writeRuntimeError(w, 503, "application_start_failed")
			return
		}
		defer release()
		proxy := httputil.NewSingleHostReverseProxy(target)
		base := proxy.Director
		proxy.Director = func(out *http.Request) {
			base(out)
			out.URL.Path = "/"
			if len(pieces) == 3 {
				out.URL.Path += pieces[2]
			}
			out.URL.RawPath = ""
			publishedapps.StripInternalHeaders(out.Header)
			out.Header.Del("Cookie")
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
			writeRuntimeError(w, 502, "application_unavailable")
		}
		proxy.ServeHTTP(w, r)
	default:
		writeRuntimeError(w, 404, "application_operation_not_found")
	}
}
