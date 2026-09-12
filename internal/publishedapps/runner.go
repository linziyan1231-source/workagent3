package publishedapps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"workagent3/internal/auth"
	"workagent3/internal/winutil"
)

type RunnerConfig struct {
	Root             string
	OwnerSID         string
	WorkerCommand    string
	NodeCommand      string
	PythonCommand    string
	OwnerJob         *winutil.Job
	AuthorizeNetwork func(context.Context, winutil.AppNetworkRule) (string, error)
	RevokeNetwork    func(context.Context, winutil.AppNetworkRule) error
}
type Runner struct {
	config         RunnerConfig
	mu             sync.Mutex
	running        map[string]*applicationProcess
	states         map[string]AppStatus
	cancel         context.CancelFunc
	building       atomic.Int64
	starting       map[string]*applicationStart
	closed         bool
	networkMu      sync.Mutex
	networkCleanup map[string]winutil.AppNetworkRule
}
type applicationStart struct {
	id      string
	slot    string
	done    chan struct{}
	cancel  context.CancelFunc
	err     error
	stopped bool
}
type AppStatus struct {
	State        string    `json:"state"`
	Error        string    `json:"error,omitempty"`
	StartedAt    time.Time `json:"startedAt,omitempty"`
	LastActivity time.Time `json:"lastActivity,omitempty"`
	LogTail      string    `json:"logTail,omitempty"`
}
type applicationProcess struct {
	process, broker      *winutil.AppProcess
	URL                  *url.URL
	id, version, logPath string
	preview              bool
	started, last        time.Time
	active               int
	done                 chan struct{}
	exitError            error
	rule                 winutil.AppNetworkRule
	once                 sync.Once
}

func NewRunner(config RunnerConfig) (*Runner, error) {
	if config.OwnerJob == nil || !filepath.IsAbs(config.Root) || !filepath.IsAbs(config.WorkerCommand) || config.AuthorizeNetwork == nil || config.RevokeNetwork == nil {
		return nil, ErrInvalid
	}
	if err := os.MkdirAll(config.Root, 0700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runner{config: config, running: map[string]*applicationProcess{}, states: map[string]AppStatus{}, starting: map[string]*applicationStart{}, cancel: cancel, networkCleanup: map[string]winutil.AppNetworkRule{}}
	if err := r.recoverSnapshots(); err != nil {
		cancel()
		return nil, err
	}
	if err := r.loadNetworkCleanup(); err != nil {
		cancel()
		return nil, err
	}
	go r.reap(ctx)
	return r, nil
}
func (r *Runner) versionPath(id, version string) (string, error) {
	if _, err := winutil.AppContainerName(id, version); err != nil {
		return "", err
	}
	return filepath.Join(r.config.Root, id, "versions", version), nil
}
func (r *Runner) manifest(id, version string) (Manifest, error) {
	directory, err := r.versionPath(id, version)
	if err != nil {
		return Manifest{}, err
	}
	raw, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return Manifest{}, err
	}
	var manifest Manifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.AppID != id || manifest.Version != version || filepath.Base(manifest.Entry) != manifest.Entry {
		return manifest, ErrInvalid
	}
	if err = Validate(App{Name: "application", WorkspaceID: "snapshot", Kind: manifest.Kind, Entry: manifest.Entry, AllowedOrigins: manifest.AllowedOrigins}); err != nil {
		return manifest, err
	}
	return manifest, nil
}
func writeWorkerJSON(path string, value any) error {
	raw, _ := json.Marshal(value)
	return os.WriteFile(path, raw, 0600)
}
func workerEnvironment(data string) []string {
	return []string{"SystemRoot=" + os.Getenv("SystemRoot"), "WINDIR=" + os.Getenv("SystemRoot"), "USERPROFILE=" + os.Getenv("USERPROFILE"), "LOCALAPPDATA=" + os.Getenv("LOCALAPPDATA"), "APPDATA=" + os.Getenv("APPDATA"), "TEMP=" + data, "TMP=" + data}
}

func (r *Runner) Snapshot(ctx context.Context, id, sourceRoot, entry string, manifest Manifest) (result Manifest, resultErr error) {
	r.building.Add(1)
	defer r.building.Add(-1)
	ctx, cancelBuild := context.WithCancel(ctx)
	defer cancelBuild()
	buildKey := "snapshot:" + id + ":" + manifest.Version
	r.mu.Lock()
	if r.closed || r.starting[buildKey] != nil {
		r.mu.Unlock()
		return Manifest{}, errors.New("application snapshot busy")
	}
	build := &applicationStart{id: id, cancel: cancelBuild, done: make(chan struct{})}
	r.starting[buildKey] = build
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.starting, buildKey); close(build.done); r.mu.Unlock() }()
	directory, err := r.versionPath(id, manifest.Version)
	if err != nil {
		return Manifest{}, err
	}
	manifest.AppID = id
	parent := filepath.Dir(directory)
	if err = os.MkdirAll(parent, 0700); err != nil {
		return Manifest{}, err
	}
	work := directory + ".staging"
	inputPath := directory + ".input.json"
	if _, err = os.Stat(directory); !errors.Is(err, os.ErrNotExist) {
		return Manifest{}, errors.New("application version already exists")
	}
	if _, err = os.Stat(work); !errors.Is(err, os.ErrNotExist) {
		return Manifest{}, errors.New("application snapshot staging already exists")
	}
	createdVersion := false
	defer func() {
		if resultErr != nil {
			status := AppStatus{State: "failed", Error: resultErr.Error(), LastActivity: time.Now()}
			if len(status.Error) > 1000 {
				status.Error = status.Error[:1000]
			}
			for _, logPath := range []string{directory + ".snapshot.log", filepath.Join(directory, "preview-data", "application.log"), filepath.Join(directory, "run", "broker.log")} {
				status.LogTail += readAppLogTail(logPath)
			}
			if len(status.LogTail) > 32*1024 {
				status.LogTail = status.LogTail[len(status.LogTail)-32*1024:]
			}
			_ = writeWorkerJSON(filepath.Join(r.config.Root, id, "last-error.json"), status)
			r.mu.Lock()
			r.states[id+":"] = status
			r.mu.Unlock()
			if createdVersion {
				_ = removeSnapshotArtifact(parent, directory)
			}
			_ = removeSnapshotArtifact(parent, work)
			_ = winutil.DeleteAppContainer(id, filepath.Base(directory))
		}
		_ = os.Remove(directory + ".snapshot.log")
	}()
	if err = writeWorkerJSON(inputPath, SnapshotInput{SourceRoot: sourceRoot, Entry: entry, Destination: work, Manifest: manifest}); err != nil {
		return Manifest{}, err
	}
	defer os.Remove(inputPath)
	process, err := winutil.StartAppProcess(winutil.AppProcessOptions{Executable: r.config.WorkerCommand, Arguments: []string{"--published-app-snapshot", inputPath}, Directory: parent, Environment: workerEnvironment(parent), OwnerJob: r.config.OwnerJob, LogPath: directory + ".snapshot.log"})
	if err != nil {
		return Manifest{}, err
	}
	defer process.Close()
	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		process.Close()
		<-done
		err = ctx.Err()
	}
	if err != nil {
		return Manifest{}, err
	}
	if err = os.Rename(work, directory); err != nil {
		return Manifest{}, err
	}
	createdVersion = true
	manifest, err = r.manifest(id, manifest.Version)
	if err != nil {
		return Manifest{}, err
	}
	// Validation uses its own appdata. It must not apply a backend's migrations
	// to live data before the owner has selected this release.
	instance, err := r.start(ctx, manifest, true)
	if instance != nil {
		r.closeProcess(instance)
	}
	if err == nil {
		_ = os.Remove(filepath.Join(r.config.Root, id, "last-error.json"))
		r.mu.Lock()
		delete(r.states, id+":")
		r.mu.Unlock()
	}
	return manifest, err
}

func removeSnapshotArtifact(parent, target string) error {
	parent = filepath.Clean(parent)
	target = filepath.Clean(target)
	if !filepath.IsAbs(parent) || filepath.Dir(target) != parent {
		return errors.New("snapshot cleanup outside version root")
	}
	name := filepath.Base(target)
	version := strings.TrimSuffix(name, ".staging")
	if _, err := winutil.AppContainerName(strings.Repeat("a", 24), version); err != nil {
		return err
	}
	return os.RemoveAll(target)
}
func readAppLogTail(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	_, _ = file.Seek(max(int64(0), info.Size()-32*1024), io.SeekStart)
	raw, _ := io.ReadAll(io.LimitReader(file, 32*1024))
	return string(raw)
}
func reserveAppPort() (int, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	err = listener.Close()
	return port, err
}
func (r *Runner) start(ctx context.Context, manifest Manifest, validation bool) (*applicationProcess, error) {
	directory, _ := r.versionPath(manifest.AppID, manifest.Version)
	bundle := filepath.Join(directory, "bundle")
	data := filepath.Join(r.config.Root, manifest.AppID, "appdata")
	if manifest.Preview || validation {
		data = filepath.Join(directory, "preview-data")
	}
	run := filepath.Join(directory, "run")
	for _, dir := range []string{data, run} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
	}
	identity, profile, err := winutil.PrepareAppContainer(manifest.AppID, manifest.Version)
	if err != nil {
		return nil, err
	}
	if err = winutil.ProtectAppTree(profile, r.config.OwnerSID, identity, false); err != nil {
		return nil, err
	}
	if err = winutil.ProtectAppProfileRegistry(manifest.AppID, manifest.Version, r.config.OwnerSID); err != nil {
		return nil, err
	}
	if err = winutil.ProtectAppTree(bundle, r.config.OwnerSID, identity, false); err != nil {
		return nil, err
	}
	if err = winutil.ProtectAppTree(data, r.config.OwnerSID, identity, true); err != nil {
		return nil, err
	}
	backendPort, err := reserveAppPort()
	if err != nil {
		return nil, err
	}
	brokerPort, err := reserveAppPort()
	if err != nil {
		return nil, err
	}
	token, err := auth.RandomToken(32)
	if err != nil {
		return nil, err
	}
	brokerAddress := net.JoinHostPort("127.0.0.1", strconv.Itoa(brokerPort))
	backendAddress := net.JoinHostPort("127.0.0.1", strconv.Itoa(backendPort))
	configFile := filepath.Join(run, "broker.json")
	if err = writeWorkerJSON(configFile, BrokerConfig{Address: brokerAddress, Token: token, AllowedOrigins: manifest.AllowedOrigins}); err != nil {
		return nil, err
	}
	broker, err := winutil.StartAppProcess(winutil.AppProcessOptions{Executable: r.config.WorkerCommand, Arguments: []string{"--published-app-broker", configFile}, Directory: run, Environment: workerEnvironment(data), OwnerJob: r.config.OwnerJob, LogPath: filepath.Join(run, "broker.log")})
	if err != nil {
		return nil, err
	}
	instance := &applicationProcess{broker: broker, id: manifest.AppID, version: manifest.Version, preview: manifest.Preview, logPath: filepath.Join(data, "application.log"), started: time.Now(), last: time.Now(), done: make(chan struct{}), rule: winutil.AppNetworkRule{AppID: manifest.AppID, Version: manifest.Version, BackendPort: backendPort, BrokerPort: brokerPort}}
	successful := false
	defer func() {
		if !successful {
			r.closeProcess(instance)
		}
	}()
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	readyCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err = waitAppReady(readyCtx, client, "http://"+brokerAddress+"/healthz", token); err != nil {
		return nil, err
	}
	granted, err := r.authorizeNetwork(ctx, instance.rule)
	if err != nil {
		return nil, err
	}
	if granted != identity {
		return nil, errors.New("application network identity mismatch")
	}
	executable := r.config.WorkerCommand
	arguments := []string{"--published-app-static", bundle, manifest.Entry, backendAddress}
	switch manifest.Kind {
	case "node":
		executable = r.config.NodeCommand
		arguments = []string{"--preserve-symlinks", "--preserve-symlinks-main", manifest.Entry}
	case "python":
		executable = r.config.PythonCommand
		arguments = []string{"-B", manifest.Entry}
	}
	if !filepath.IsAbs(executable) {
		return nil, errors.New("application interpreter is not configured")
	}
	environment := []string{"SystemRoot=" + os.Getenv("SystemRoot"), "WINDIR=" + os.Getenv("SystemRoot"), "USERPROFILE=" + data, "LOCALAPPDATA=" + data, "APPDATA=" + data, "TEMP=" + data, "TMP=" + data, "HOME=" + data, "PORT=" + strconv.Itoa(backendPort), "HOST=127.0.0.1", "APP_DATA=" + data, "WORKAGENT_APP_DATA=" + data, "WORKAGENT_APP_BROKER_URL=http://" + brokerAddress, "WORKAGENT_APP_BROKER_TOKEN=" + token, "PYTHONDONTWRITEBYTECODE=1", "PYTHONNOUSERSITE=1", "PIP_CACHE_DIR=" + data, "npm_config_cache=" + data}
	// No Portal/runtime tokens, employee profile variables or model credentials
	// are inherited. The executable and public software trees are provisioned RX.
	instance.process, err = winutil.StartAppProcess(winutil.AppProcessOptions{Executable: executable, Arguments: arguments, Directory: bundle, Environment: environment, OwnerJob: r.config.OwnerJob, PackageSID: identity, LogPath: instance.logPath})
	if err != nil {
		return nil, err
	}
	go func() {
		select {
		case <-instance.broker.Done():
			instance.process.Close()
			instance.exitError = errors.New("application outbound broker stopped")
		case <-instance.process.Done():
			instance.broker.Close()
			instance.exitError = instance.process.Wait()
		}
		cancel()
		r.closeProcess(instance)
		close(instance.done)
	}()
	instance.URL, _ = url.Parse("http://" + backendAddress)
	if err = waitAppReady(readyCtx, client, instance.URL.String()+"/", ""); err != nil {
		select {
		case <-instance.process.Done():
			return nil, fmt.Errorf("application exited before becoming ready: %v", instance.process.Wait())
		default:
		}
		return nil, fmt.Errorf("application did not start: %w", err)
	}
	if err = winutil.VerifyAppListener(backendPort, r.config.OwnerSID, identity, instance.process.PID); err != nil {
		return nil, err
	}
	successful = true
	return instance, nil
}
func waitAppReady(ctx context.Context, client *http.Client, address, token string) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, _ := http.NewRequestWithContext(ctx, "GET", address, nil)
		if token != "" {
			request.Header.Set("X-App-Broker-Token", token)
		}
		response, err := client.Do(request)
		if err == nil {
			response.Body.Close()
			if response.StatusCode < 500 {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
func (r *Runner) Acquire(ctx context.Context, id, version string, preview bool) (*url.URL, func(), error) {
	key := id + ":" + version
	manifest, err := r.manifest(id, version)
	if err != nil {
		return nil, nil, err
	}
	if manifest.Preview != preview {
		return nil, nil, ErrInvalid
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, nil, errors.New("application runner closed")
	}
	if pending := r.starting[key]; pending != nil {
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-pending.done:
			if pending.err != nil {
				return nil, nil, pending.err
			}
			return r.Acquire(ctx, id, version, preview)
		}
	}
	slot := id + ":" + strconv.FormatBool(preview)
	for otherKey, pending := range r.starting {
		if pending.slot == slot && otherKey != key {
			pending.stopped = true
			pending.cancel()
			r.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			case <-pending.done:
				return r.Acquire(ctx, id, version, preview)
			}
		}
	}
	instance := r.running[key]
	if instance != nil {
		select {
		case <-instance.done:
			r.closeProcess(instance)
			delete(r.running, key)
			instance = nil
		default:
		}
	}
	if instance == nil {
		for otherKey, other := range r.running {
			if other.id == id && other.preview == preview {
				r.closeProcess(other)
				delete(r.running, otherKey)
			}
		}
		startContext, cancel := context.WithCancel(ctx)
		pending := &applicationStart{id: id, slot: slot, cancel: cancel, done: make(chan struct{})}
		r.starting[key] = pending
		r.states[key] = AppStatus{State: "starting"}
		r.mu.Unlock()
		instance, err = r.start(startContext, manifest, false)
		cancel()
		r.mu.Lock()
		if (pending.stopped || r.closed) && err == nil {
			r.closeProcess(instance)
			err = context.Canceled
		}
		pending.err = err
		delete(r.starting, key)
		close(pending.done)
		if err != nil {
			r.states[key] = AppStatus{State: "failed", Error: err.Error(), LastActivity: time.Now()}
			if pending.stopped || r.closed {
				r.states[key] = AppStatus{State: "stopped", LastActivity: time.Now()}
			}
			r.mu.Unlock()
			return nil, nil, err
		}
		r.running[key] = instance
	}
	instance.active++
	instance.last = time.Now()
	r.mu.Unlock()
	return instance.URL, func() { r.mu.Lock(); defer r.mu.Unlock(); instance.active--; instance.last = time.Now() }, nil
}
func (r *Runner) closeProcess(instance *applicationProcess) {
	instance.once.Do(func() {
		if instance.process != nil {
			instance.process.Close()
		}
		if instance.broker != nil {
			instance.broker.Close()
		}
		r.revokeNetwork(instance.rule)
	})
}
func (r *Runner) Stop(id string) {
	r.mu.Lock()
	var stopped []*applicationProcess
	var pendingDone []<-chan struct{}
	for _, pending := range r.starting {
		if pending.id == id {
			pending.stopped = true
			pending.cancel()
			pendingDone = append(pendingDone, pending.done)
		}
	}
	for key, instance := range r.running {
		if instance.id == id {
			stopped = append(stopped, instance)
			r.states[key] = AppStatus{State: "stopped", StartedAt: instance.started, LastActivity: instance.last}
			delete(r.running, key)
		}
	}
	r.mu.Unlock()
	for _, instance := range stopped {
		r.closeProcess(instance)
	}
	for _, done := range pendingDone {
		<-done
	}
}
func (r *Runner) Status(id, version string) AppStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := id + ":" + version
	status := r.states[key]
	if version == "" && status.State == "" {
		if _, err := winutil.AppContainerName(id, strings.Repeat("v", 24)); err == nil {
			if raw, err := os.ReadFile(filepath.Join(r.config.Root, id, "last-error.json")); err == nil && len(raw) < 40*1024 {
				_ = json.Unmarshal(raw, &status)
			}
		}
	}
	if version == "" {
		if status.State == "failed" {
			return status
		}
		var selected *applicationProcess
		for _, candidate := range r.running {
			if candidate.id == id && (selected == nil || !candidate.preview) {
				selected = candidate
				if !candidate.preview {
					break
				}
			}
		}
		if selected != nil {
			version = selected.version
			key = id + ":" + version
		} else {
			for stateKey, candidate := range r.states {
				if strings.HasPrefix(stateKey, id+":") && candidate.State == "failed" && (status.State != "failed" || candidate.LastActivity.After(status.LastActivity)) {
					status = candidate
					version = strings.TrimPrefix(stateKey, id+":")
				}
			}
		}
	}
	if status.State == "" {
		status.State = "stopped"
	}
	logPath := ""
	if instance := r.running[key]; instance != nil {
		status = AppStatus{State: "running", StartedAt: instance.started, LastActivity: instance.last}
		select {
		case <-instance.done:
			status.State = "failed"
			status.Error = "application stopped"
			if instance.exitError != nil {
				status.Error = instance.exitError.Error()
			}
		default:
		}
		logPath = instance.logPath
	} else if directory, err := r.versionPath(id, version); err == nil {
		manifest, err := r.manifest(id, version)
		if err == nil {
			logPath = filepath.Join(r.config.Root, id, "appdata", "application.log")
			if manifest.Preview {
				logPath = filepath.Join(directory, "preview-data", "application.log")
			}
		}
	}
	if file, err := os.Open(logPath); err == nil {
		defer file.Close()
		if info, err := file.Stat(); err == nil {
			offset := max(int64(0), info.Size()-32*1024)
			file.Seek(offset, io.SeekStart)
			raw, _ := io.ReadAll(io.LimitReader(file, 32*1024))
			status.LogTail = string(raw)
		}
	}
	return status
}
func (r *Runner) reap(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.mu.Lock()
			var stopped []*applicationProcess
			for key, instance := range r.running {
				if instance.active == 0 && time.Since(instance.last) > 5*time.Minute {
					stopped = append(stopped, instance)
					r.states[key] = AppStatus{State: "idle", StartedAt: instance.started, LastActivity: instance.last}
					delete(r.running, key)
				}
			}
			r.mu.Unlock()
			for _, instance := range stopped {
				r.closeProcess(instance)
			}
			r.retryNetworkCleanup()
		}
	}
}
func (r *Runner) Close() error {
	r.cancel()
	r.mu.Lock()
	var stopped []*applicationProcess
	var pendingDone []<-chan struct{}
	r.closed = true
	for _, pending := range r.starting {
		pending.stopped = true
		pending.cancel()
		pendingDone = append(pendingDone, pending.done)
	}
	for key, instance := range r.running {
		stopped = append(stopped, instance)
		delete(r.running, key)
	}
	r.mu.Unlock()
	for _, instance := range stopped {
		r.closeProcess(instance)
	}
	for _, done := range pendingDone {
		<-done
	}
	return nil
}

func (r *Runner) Activity() bool {
	if r.building.Load() > 0 {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.starting) > 0 {
		return true
	}
	for _, instance := range r.running {
		if instance.active > 0 || time.Since(instance.last) < 5*time.Minute {
			return true
		}
	}
	return false
}

// StripInternalHeaders restores only the application authorization value that
// Portal carried through its authenticated internal hop.
func StripInternalHeaders(header http.Header) {
	authorization := header.Get("X-WorkAgent-App-Authorization")
	origin := header.Get("X-WorkAgent-App-Origin")
	for key := range header {
		if strings.HasPrefix(strings.ToLower(key), "x-workagent-") {
			header.Del(key)
		}
	}
	header.Del("Authorization")
	header.Del("Origin")
	if authorization != "" {
		header.Set("Authorization", authorization)
	}
	if origin != "" {
		header.Set("Origin", origin)
	}
}
