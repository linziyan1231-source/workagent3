package userhost

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/nativeauth"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/winutil"
)

var ErrRestartRequested = errors.New("runtime restart requested")

type Config struct {
	SID                string
	DataRoot           string
	Command            string
	CodexCommand       string
	KimiCommand        string
	Arguments          []string
	Profile            string
	Limits             winutil.JobLimits
	StartupTimeout     time.Duration
	ManagedSkillsRoot  string
	ManagedToolsRoot   string
	ManagedMCPServers  []mcpruntime.Server
	PlatformURL        string
	PlatformCredential string
	// HarnessModel and ModelGatewayBaseURL describe the managed model route the
	// Harness shares with native Codex: the same SID-private CLIProxyAPI
	// loopback and the configured Codex model. Both are empty only when the
	// deployment has no managed model gateway.
	HarnessModel        string
	ModelGatewayBaseURL string
}

type Supervisor struct {
	config           Config
	job              *winutil.Job
	lock             *winutil.InstanceLock
	cmd              *exec.Cmd
	harnessLog       *os.File
	exited           chan error
	gateway          *runtimeGateway
	gatewayExited    chan error
	restartRequested chan struct{}
	once             sync.Once
}

func New(config Config) (*Supervisor, error) {
	if config.SID == "" || config.DataRoot == "" || config.Command == "" || config.Profile == "" || config.PlatformURL == "" || config.PlatformCredential == "" {
		return nil, errors.New("SID, data root, command, profile, and Platform capability are required")
	}
	if !filepath.IsAbs(config.DataRoot) {
		return nil, errors.New("data root must be absolute")
	}
	if (config.CodexCommand != "" && !filepath.IsAbs(config.CodexCommand)) ||
		(config.KimiCommand != "" && !filepath.IsAbs(config.KimiCommand)) ||
		(config.ManagedSkillsRoot != "" && !filepath.IsAbs(config.ManagedSkillsRoot)) ||
		(config.ManagedToolsRoot != "" && !filepath.IsAbs(config.ManagedToolsRoot)) {
		return nil, errors.New("native engine commands and managed skills root must be absolute")
	}
	if config.StartupTimeout <= 0 {
		config.StartupTimeout = 45 * time.Second
	}
	if (config.HarnessModel == "") != (config.ModelGatewayBaseURL == "") {
		return nil, errors.New("Harness model and model gateway base URL must be configured together")
	}
	if config.ModelGatewayBaseURL != "" {
		if err := nativeauth.ValidateBaseURL(config.ModelGatewayBaseURL); err != nil {
			return nil, err
		}
		if !nativeauth.ValidModel(config.HarnessModel) {
			return nil, errors.New("Harness model is invalid")
		}
	}
	return &Supervisor{config: config, restartRequested: make(chan struct{}, 1)}, nil
}

func (s *Supervisor) Start(ctx context.Context) (runtimeapi.Registration, error) {
	if err := winutil.RequireSID(s.config.SID); err != nil {
		return runtimeapi.Registration{}, err
	}
	lock, err := winutil.AcquireInstanceLock("WorkAgent3-Harness-" + strings.ReplaceAll(s.config.SID, "-", "_"))
	if err != nil {
		return runtimeapi.Registration{}, err
	}
	s.lock = lock
	directories, err := ensureDirectories(s.config.DataRoot)
	if err != nil {
		lock.Close()
		return runtimeapi.Registration{}, err
	}
	if s.config.HarnessModel != "" {
		if err := projectModelAccess(directories.dshHome, s.config.HarnessModel); err != nil {
			lock.Close()
			return runtimeapi.Registration{}, fmt.Errorf("project Harness model access: %w", err)
		}
	}
	// A staged bootstrap is the version marker for managed model delivery: its
	// presence means the newest bundle has not reached every consumer yet, so
	// startup (and Repair, which always stages a fresh bundle) replays the
	// ordered delivery below.
	bundle, staged, err := nativeauth.Load(s.config.DataRoot)
	if err != nil {
		lock.Close()
		return runtimeapi.Registration{}, fmt.Errorf("load SID-private native model access: %w", err)
	}
	if staged {
		// Ordered delivery step 1: write the native Codex/Kimi credentials.
		if err := nativeauth.Apply(s.config.DataRoot); err != nil {
			lock.Close()
			return runtimeapi.Registration{}, fmt.Errorf("apply SID-private native model access: %w", err)
		}
	}
	port, err := reserveLoopbackPort()
	if err != nil {
		lock.Close()
		return runtimeapi.Registration{}, err
	}
	token, err := auth.RandomToken(32)
	if err != nil {
		lock.Close()
		return runtimeapi.Registration{}, err
	}
	job, err := winutil.NewJob("WorkAgent3-"+strings.ReplaceAll(s.config.SID, "-", "_"), s.config.Limits)
	if err != nil {
		lock.Close()
		return runtimeapi.Registration{}, err
	}
	arguments := append([]string{}, s.config.Arguments...)
	arguments = append(arguments, "--profile", s.config.Profile)
	harnessLog, err := os.OpenFile(filepath.Join(directories.logs, "harness.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		job.Close()
		lock.Close()
		return runtimeapi.Registration{}, fmt.Errorf("open private Harness log: %w", err)
	}
	command := exec.Command(s.config.Command, arguments...)
	command.Dir = directories.workspace
	command.Env = runtimeEnvironment(directories, token, port, s.config.SID, s.config.PlatformURL, s.config.PlatformCredential, s.config.CodexCommand, s.config.KimiCommand, s.config.ManagedToolsRoot, s.config.ModelGatewayBaseURL, s.config.HarnessModel)
	command.Stdout = harnessLog
	command.Stderr = harnessLog
	if err := command.Start(); err != nil {
		harnessLog.Close()
		job.Close()
		lock.Close()
		return runtimeapi.Registration{}, fmt.Errorf("start Harness: %w", err)
	}
	if err := job.AssignPID(uint32(command.Process.Pid)); err != nil {
		command.Process.Kill()
		harnessLog.Close()
		job.Close()
		lock.Close()
		return runtimeapi.Registration{}, err
	}
	s.job, s.cmd, s.harnessLog = job, command, harnessLog
	done := make(chan error, 1)
	s.exited = done
	go func() { done <- command.Wait() }()
	healthURL := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	if err := waitForHealth(ctx, healthURL, token, done, s.config.StartupTimeout); err != nil {
		s.Close()
		return runtimeapi.Registration{}, err
	}
	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	var stagedBundle *nativeauth.Bundle
	if staged {
		stagedBundle = &bundle
	}
	// Business audit reporting (Skill/MCP lifecycle, MCP OAuth) goes through
	// the Portal loopback endpoint; a misconfigured audit path must not block
	// the runtime, so the client is nil on error.
	auditSink, _ := newAuditClient(s.config.PlatformURL, s.config.PlatformCredential, s.config.SID)
	gateway, err := newRuntimeGateway(directories.runtime, directories.dshHome, s.config.ManagedSkillsRoot, s.config.ManagedMCPServers, s.config.ManagedToolsRoot, s.config.DataRoot, s.config.SID, target, token, stagedBundle, auditSink, func() {
		select {
		case s.restartRequested <- struct{}{}:
		default:
		}
	}, job)
	if err != nil {
		s.Close()
		return runtimeapi.Registration{}, err
	}
	if staged {
		// Ordered delivery steps 2 and 3 (broker record plus Harness
		// re-projection) completed inside newRuntimeGateway; only now is the
		// bundle consumed.
		if err := nativeauth.Consume(s.config.DataRoot); err != nil {
			gateway.Close()
			s.Close()
			return runtimeapi.Registration{}, err
		}
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		gateway.Close()
		s.Close()
		return runtimeapi.Registration{}, err
	}
	s.gateway = gateway
	s.gatewayExited = make(chan error, 1)
	go func() { s.gatewayExited <- gateway.server.Serve(listener) }()
	return runtimeapi.Registration{SID: s.config.SID, BaseURL: "http://" + listener.Addr().String(), Token: token, ExpiresAt: time.Now().Add(2 * time.Minute)}, nil
}

// Serve owns the complete runtime lease. A healthy Harness is published
// immediately, renewed before expiry, and removed when the process or context
// ends.
func (s *Supervisor) Serve(ctx context.Context, reporter LeaseReporter) error {
	if reporter == nil {
		return errors.New("runtime lease reporter is required")
	}
	registration, err := s.Start(ctx)
	if err != nil {
		return err
	}
	defer s.Close()
	if err := reporter.Publish(ctx, registration); err != nil {
		return err
	}
	defer func() {
		removeContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = reporter.Remove(removeContext, registration)
	}()
	ticker := time.NewTicker(runtimeapi.DefaultLeaseDuration / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case processErr := <-s.exited:
			if processErr == nil {
				return errors.New("Harness exited")
			}
			return fmt.Errorf("Harness exited: %w", processErr)
		case gatewayErr := <-s.gatewayExited:
			if errors.Is(gatewayErr, http.ErrServerClosed) {
				return errors.New("Runtime gateway stopped")
			}
			return fmt.Errorf("Runtime gateway stopped: %w", gatewayErr)
		case <-s.restartRequested:
			return ErrRestartRequested
		case <-ticker.C:
			if err := reporter.Publish(ctx, registration); err != nil {
				return err
			}
		}
	}
}

func (s *Supervisor) Close() error {
	var err error
	s.once.Do(func() {
		if s.gateway != nil {
			err = s.gateway.Close()
		}
		if s.job != nil {
			jobErr := s.job.Close()
			if err == nil {
				err = jobErr
			}
		}
		if s.harnessLog != nil {
			logErr := s.harnessLog.Close()
			if err == nil {
				err = logErr
			}
		}
		if s.lock != nil {
			lockErr := s.lock.Close()
			if err == nil {
				err = lockErr
			}
		}
	})
	return err
}

type privateDirectories struct {
	dshHome   string
	workspace string
	native    string
	runtime   string
	logs      string
}

func ensureDirectories(root string) (privateDirectories, error) {
	directories := privateDirectories{
		dshHome: filepath.Join(root, "dsh-home"), workspace: filepath.Join(root, "workspace"), native: filepath.Join(root, "native"),
		runtime: filepath.Join(root, "runtime"), logs: filepath.Join(root, "logs"),
	}
	for _, path := range []string{directories.dshHome, directories.workspace, filepath.Join(directories.native, "codex"), filepath.Join(directories.native, "kimi"), directories.runtime, directories.logs} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return privateDirectories{}, fmt.Errorf("create private runtime directory: %w", err)
		}
	}
	return directories, nil
}

func reserveLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("reserve loopback port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return 0, err
	}
	return port, nil
}

func runtimeEnvironment(directories privateDirectories, token string, port int, sid, platformURL, platformCredential, codexCommand, kimiCommand, managedToolsRoot, gatewayBaseURL, harnessModel string) []string {
	allowed := map[string]struct{}{"SystemRoot": {}, "WINDIR": {}, "PATH": {}, "PATHEXT": {}, "TEMP": {}, "TMP": {}, "ComSpec": {}, "LOCALAPPDATA": {}, "APPDATA": {}, "USERPROFILE": {}, "USERNAME": {}}
	environment := make([]string, 0, len(allowed)+5)
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		for allowedKey := range allowed {
			if strings.EqualFold(key, allowedKey) {
				environment = append(environment, value)
				break
			}
		}
	}
	environment = append(environment,
		"DSH_HOME="+directories.dshHome,
		"WORKAGENT_WORKSPACE_ROOT="+directories.workspace,
		"CODEX_HOME="+filepath.Join(directories.native, "codex"),
		"KIMI_CODE_HOME="+filepath.Join(directories.native, "kimi"),
		"WORKAGENT_RUNTIME_TOKEN="+token,
		"WORKAGENT_RUNTIME_PORT="+strconv.Itoa(port),
		"WORKAGENT_EMPLOYEE_SID="+sid,
		"WORKAGENT_PLATFORM_URL="+strings.TrimRight(platformURL, "/"),
		"WORKAGENT_PLATFORM_TOKEN="+platformCredential,
	)
	if codexCommand != "" {
		environment = append(environment, "WORKAGENT_CODEX_BIN="+codexCommand)
	}
	if kimiCommand != "" {
		environment = append(environment, "WORKAGENT_KIMI_BIN="+kimiCommand)
	}
	if managedToolsRoot != "" {
		for index, value := range environment {
			if key, current, found := strings.Cut(value, "="); found && strings.EqualFold(key, "PATH") {
				environment[index] = key + "=" + managedToolsRoot + string(os.PathListSeparator) + current
				break
			}
		}
	}
	if gatewayBaseURL != "" {
		// The managed Harness provider always targets the SID-local CLIProxyAPI
		// loopback from configuration, never an inherited environment value.
		environment = append(environment,
			"DEEPSEEK_BASE_URL="+gatewayBaseURL,
			"WORKAGENT_HARNESS_MODEL="+harnessModel,
		)
	}
	return environment
}

func waitForHealth(ctx context.Context, endpoint, token string, done <-chan error, timeout time.Duration) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	client := &http.Client{Timeout: time.Second}
	for {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		if response, err := client.Do(request); err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-done:
			if err == nil {
				return errors.New("Harness exited during startup")
			}
			return fmt.Errorf("Harness exited during startup: %w", err)
		case <-deadline.C:
			return errors.New("Harness did not become healthy before startup timeout")
		case <-ticker.C:
		}
	}
}
