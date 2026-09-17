package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
	"workagent3/internal/employee"
	"workagent3/internal/employeemanager"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/modelaccess"
	"workagent3/internal/modelgateway"
	"workagent3/internal/quota"
	"workagent3/internal/sharedtrash"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

type managerConfig struct {
	ProfessionalDatabase   *professionalDatabaseConfig   `json:"professionalDatabase,omitempty"`
	RuntimePolicy          employeemanager.RuntimePolicy `json:"runtimePolicy"`
	StorageLimits          *contracts.StorageLimits      `json:"storageLimits,omitempty"`
	CredentialRoot         string                        `json:"credentialRoot,omitempty"`
	LauncherExecutable     string                        `json:"launcherExecutable,omitempty"`
	LaunchManifestRoot     string                        `json:"launchManifestRoot,omitempty"`
	DatabasePath           string                        `json:"databasePath"`
	DataRootBase           string                        `json:"dataRootBase"`
	UserHostExecutable     string                        `json:"userHostExecutable"`
	HarnessCommand         string                        `json:"harnessCommand"`
	PublishedPythonCommand string                        `json:"publishedPythonCommand,omitempty"`
	HarnessEntrypoint      string                        `json:"harnessEntrypoint"`
	CodexCommand           string                        `json:"codexCommand,omitempty"`
	KimiCommand            string                        `json:"kimiCommand,omitempty"`
	HarnessArguments       []string                      `json:"harnessArguments,omitempty"`
	Profile                string                        `json:"profile"`
	HarnessProfileSource   string                        `json:"harnessProfileSource"`
	ManagedSkillsRoot      string                        `json:"managedSkillsRoot"`
	ManagedToolsRoot       string                        `json:"managedToolsRoot,omitempty"`
	ManagedMCPServers      []mcpruntime.Server           `json:"managedMcpServers,omitempty"`
	PortalURL              string                        `json:"portalUrl"`
	PublicBaseURL          string                        `json:"publicBaseURL,omitempty"`
	Limits                 winutil.JobLimits             `json:"limits"`
	// ModelGateway holds the CLIProxyAPI downstream key policy. Model and quota
	// values are mandatory when present — no code defaults exist; see
	// docs/employee-manager.config.example.json for the full template.
	ModelGateway *modelgateway.Config `json:"modelGateway,omitempty"`
	// AuditDatabasePath stores business audit events (employee lifecycle and
	// model gateway key lifecycle). It defaults to audit.db beside the Portal
	// database, shared with the Portal process.
	AuditDatabasePath string `json:"auditDatabasePath,omitempty"`
	// QuotaDatabasePath is the quota database the usage drain writes gateway
	// key digests and drained usage records into. It must point at the same
	// quota.db the Portal serves (it defaults beside this database), because
	// settlement matching and the usage page read what the drain writes.
	QuotaDatabasePath string `json:"quotaDatabasePath,omitempty"`
	// ModelAccessDatabasePath is the model access database holding the model
	// catalog and per-SID authorizations. It must point at the same
	// model-access.db the Portal serves (it defaults beside this database);
	// provision and repair seed the employee's default authorizations into it.
	ModelAccessDatabasePath string `json:"modelAccessDatabasePath,omitempty"`
	// HarnessEnvironment carries deployment-supplied environment variables for
	// every employee Harness process (e.g. DSH_BOOKING_* for an embedded
	// bundle); supervisor-managed keys are rejected by validation.
	HarnessEnvironment map[string]string `json:"harnessEnvironment,omitempty"`
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configPath := flag.String("config", "", "absolute Employee Manager configuration path")
	action := flag.String("action", "add", "employee lifecycle action: add, enable, disable, restart, reset-password, repair, rename-windows, set-limits, offboard-retain, offboard-delete, grant-admin, revoke-admin; offline SYSTEM maintenance: adopt-windows-credential, rotate-windows-credential, backup-windows-credential, restore-windows-credential")
	username := flag.String("username", "", "Windows and Portal username")
	newWindowsUsername := flag.String("new-windows-username", "", "new local Windows username for rename-windows")
	sourcePID := flag.Uint("source-process-id", 0, "existing employee process for one-time credential adoption")
	recoveryFile := flag.String("recovery-file", "", "new encrypted Windows credential recovery file")
	deleteConfirmation := flag.String("confirm-delete", "", "exact DELETE <username> confirmation for offboard-delete")
	memoryBytes := flag.Uint64("memory-bytes", 0, "Job Object memory limit for set-limits")
	cpuPercent := flag.Uint("cpu-percent", 0, "Job Object CPU percent for set-limits")
	activeProcesses := flag.Uint("active-processes", 0, "Job Object process limit for set-limits")
	listen := flag.String("listen", "", "serve the protected Employee Manager API on a 127.0.0.1 address")
	tokenFile := flag.String("token-file", "", "absolute path to the protected Employee Manager API token")
	flag.Parse()
	if !filepath.IsAbs(*configPath) || (*listen == "" && *username == "") {
		return errors.New("absolute --config and either --username or --listen are required")
	}
	config, err := loadManagerConfig(*configPath)
	if err != nil {
		return err
	}
	if err := validateProfessionalDatabaseConfig(config.ProfessionalDatabase); err != nil {
		return err
	}
	// Fail fast before touching any state: the employee scheduled tasks are
	// SDDL-isolated to SYSTEM, so an interactive Administrator run of a
	// task-controlling action would otherwise fail halfway through (e.g. at
	// Start-ScheduledTask) and leave the account disabled. The loopback
	// service mode is excluded here: it is deployed as SYSTEM.
	if *listen == "" {
		if err := requireTaskControlIdentity(*action); err != nil {
			return err
		}
	}
	var password []byte
	if *listen == "" && (*action == "add" || *action == "reset-password" || *action == "backup-windows-credential" || *action == "restore-windows-credential") {
		password, err = io.ReadAll(io.LimitReader(os.Stdin, 257))
		if err != nil {
			return fmt.Errorf("read Portal password: %w", err)
		}
		defer zero(password)
		password = bytesTrimLineEnding(password)
	}
	data, err := store.Open(config.DatabasePath)
	if err != nil {
		return err
	}
	defer data.Close()
	var nativeModels employee.NativeModelProvisioner
	var keys employee.KeyLifecycle
	var harnessModel, modelGatewayBaseURL string
	auditPath := config.AuditDatabasePath
	if auditPath == "" {
		auditPath = filepath.Join(filepath.Dir(config.DatabasePath), "audit.db")
	}
	if err := os.MkdirAll(filepath.Dir(auditPath), 0o700); err != nil {
		return fmt.Errorf("create audit data directory: %w", err)
	}
	auditStore, err := audit.Open(auditPath)
	if err != nil {
		return err
	}
	defer auditStore.Close()
	var drainer *modelgateway.UsageDrainer
	var entitlements employee.EntitlementSeeder
	if config.ModelGateway != nil {
		gateway, err := modelgateway.NewCLIProxy(*config.ModelGateway)
		if err != nil {
			return err
		}
		gateway.SetAudit(auditStore, "employee-manager")
		quotaPath := config.QuotaDatabasePath
		if quotaPath == "" {
			quotaPath = filepath.Join(filepath.Dir(config.DatabasePath), "quota.db")
		}
		if err := os.MkdirAll(filepath.Dir(quotaPath), 0o700); err != nil {
			return fmt.Errorf("create quota data directory: %w", err)
		}
		// The drain store shares quota.db with the Portal: the drain is the
		// single writer of gateway usage and key digests, the Portal reads them
		// for settlement matching and the usage page.
		quotaRecorder, err := quota.OpenRecorder(quotaPath)
		if err != nil {
			return err
		}
		defer quotaRecorder.Close()
		gateway.SetKeyIndexer(quotaRecorder)
		drainer, err = gateway.NewUsageDrainer(quotaRecorder)
		if err != nil {
			return err
		}
		modelAccessPath := config.ModelAccessDatabasePath
		if modelAccessPath == "" {
			modelAccessPath = filepath.Join(filepath.Dir(config.DatabasePath), "model-access.db")
		}
		if err := os.MkdirAll(filepath.Dir(modelAccessPath), 0o700); err != nil {
			return fmt.Errorf("create model access data directory: %w", err)
		}
		// The model access store is shared with the Portal over the same
		// model-access.db; provision/repair seeds the employee's default
		// authorizations and quota budgets into it.
		modelAccess, err := modelaccess.Open(modelAccessPath)
		if err != nil {
			return err
		}
		defer modelAccess.Close()
		entitlements = entitlementSeeder{models: modelAccess, quotas: quotaRecorder, config: *config.ModelGateway}
		nativeModels, keys = gateway, gateway
		harnessModel, modelGatewayBaseURL = config.ModelGateway.CodexModel, config.ModelGateway.BaseURL
	}
	platform, err := employee.NewWindowsPlatform(employee.WindowsPlatformConfig{
		MaxRunningRuntimes: config.RuntimePolicy.MaxRunningRuntimes,
		StorageLimits:      config.StorageLimits,
		CredentialRoot:     config.CredentialRoot, LauncherExecutable: config.LauncherExecutable, LaunchManifestRoot: config.LaunchManifestRoot,
		DataRootBase: config.DataRootBase, UserHostExecutable: config.UserHostExecutable,
		HarnessCommand: config.HarnessCommand, HarnessEntrypoint: config.HarnessEntrypoint,
		PublishedPythonCommand: config.PublishedPythonCommand,
		CodexCommand:           config.CodexCommand,
		KimiCommand:            config.KimiCommand, HarnessArguments: config.HarnessArguments,
		Profile: config.Profile, HarnessProfileSource: config.HarnessProfileSource,
		ManagedSkillsRoot: config.ManagedSkillsRoot,
		ManagedToolsRoot:  config.ManagedToolsRoot,
		ManagedMCPServers: config.ManagedMCPServers,
		PublicBaseURL:     config.PublicBaseURL,
		PortalURL:         config.PortalURL, Limits: config.Limits, NativeModels: nativeModels,
		HarnessModel: harnessModel, ModelGatewayBaseURL: modelGatewayBaseURL,
		ProfessionalDatabaseURL: professionalDatabaseURL(config.ProfessionalDatabase),
		HarnessEnvironment:      config.HarnessEnvironment,
	})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	provisioner := employee.Provisioner{Platform: platform, Users: data, Runtimes: data, Secrets: employee.RandomSecrets{}, Entitlements: entitlements}
	lifecycle := employee.Lifecycle{Platform: platform, Users: data, Keys: keys, Entitlements: entitlements}
	if *listen != "" {
		if drainer != nil {
			go runUsageDrain(ctx, drainer, usageDrainInterval)
		}
		transfers, err := employeemanager.NewSharedTransferManager(config.DataRootBase)
		if err != nil {
			return err
		}
		jobs, err := employeemanager.OpenJobStore(filepath.Join(filepath.Dir(config.DatabasePath), "employee-jobs.db"))
		if err != nil {
			return err
		}
		defer jobs.Close()
		trash, err := sharedtrash.New(config.DataRootBase)
		if err != nil {
			return err
		}
		service := &employeemanager.Service{Storage: platform, Provisioner: &provisioner, Lifecycle: lifecycle, Users: data, SharedTransfers: transfers, SharedTrash: trash, Audit: auditStore, Jobs: jobs}
		closeDatabase, err := configureProfessionalDatabase(config.ProfessionalDatabase, service)
		if err != nil {
			return err
		}
		defer closeDatabase()
		go service.RunSharedTrashRetention(ctx)
		if err := service.RestoreJobs(); err != nil {
			return err
		}
		return serveManager(ctx, *listen, *tokenFile, service, config)
	}
	var user store.User
	switch *action {
	case "add":
		user, err = provisioner.Add(ctx, *username, password)
	case "enable", "disable":
		user, err = lifecycle.SetEnabled(ctx, *username, *action == "enable")
	case "reset-password":
		err = lifecycle.ResetPortalPassword(ctx, *username, password)
		if err == nil {
			user, err = data.UserByUsername(ctx, *username)
		}
	case "set-limits":
		limits := winutil.JobLimits{MemoryBytes: *memoryBytes, CPUPercent: uint32(*cpuPercent), ActiveProcesses: uint32(*activeProcesses)}
		user, err = lifecycle.SetLimits(ctx, *username, limits)
	case "offboard-retain":
		user, err = lifecycle.OffboardRetain(ctx, *username)
	case "repair":
		user, err = lifecycle.Repair(ctx, *username, password)
	case "restart":
		err = lifecycle.Restart(ctx, *username)
		if err == nil {
			user, err = data.UserByUsername(ctx, *username)
		}
	case "adopt-windows-credential", "rotate-windows-credential":
		user, err = data.UserByUsername(ctx, *username)
		if err == nil {
			err = platform.MaintainWindowsCredential(ctx, user, uint32(*sourcePID), *action == "adopt-windows-credential")
		}
	case "inspect-windows-credential":
		user, err = data.UserByUsername(ctx, *username)
		if err == nil {
			var count int
			count, err = platform.InspectWindowsCredentialMigration(ctx, user, uint32(*sourcePID))
			if err == nil {
				fmt.Printf("Credential migration preflight passed: %d broker records; no external encrypted material found\n", count)
			}
		}
	case "backup-windows-credential":
		user, err = data.UserByUsername(ctx, *username)
		if err == nil {
			err = platform.BackupWindowsCredential(user, password, *recoveryFile)
		}
	case "restore-windows-credential":
		user, err = data.UserByUsername(ctx, *username)
		if err == nil {
			err = platform.RestoreWindowsCredential(user, password, *recoveryFile)
		}
	case "rename-windows":
		user, err = lifecycle.RenameWindowsAccount(ctx, *username, *newWindowsUsername, password)
	case "offboard-delete":
		err = lifecycle.DeleteRetainedEmployee(ctx, *username, *deleteConfirmation)
		user = store.User{Username: *username, Disabled: true, Offboarded: true}
	case "grant-admin", "revoke-admin":
		user, err = (employee.Lifecycle{Users: data}).SetPortalAdmin(ctx, *username, *action == "grant-admin")
	default:
		return errors.New("unsupported employee lifecycle action")
	}
	recordCLIAudit(ctx, auditStore, *action, *username, err)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"action": *action, "id": user.ID, "username": user.Username, "enabled": !user.Disabled, "admin": user.Admin})
}

// currentProcessSID is injectable for tests.
var currentProcessSID = winutil.CurrentSID

// taskControlActions register, start, stop, or unregister the employee
// scheduled task (WorkAgent3-<SID>). The task SDDL grants control to SYSTEM
// only, so these CLI actions must run as SYSTEM (or through the loopback
// Employee Manager service, which runs as SYSTEM). The remaining actions
// (reset-password, grant-admin, revoke-admin) never touch scheduled tasks.
var taskControlActions = map[string]bool{
	"inspect-windows-credential": true,
	"restart":                    true,
	"adopt-windows-credential":   true,
	"rotate-windows-credential":  true,
	"backup-windows-credential":  true,
	"restore-windows-credential": true,
	"add":                        true,
	"enable":                     true,
	"disable":                    true,
	"repair":                     true,
	"rename-windows":             true,
	"set-limits":                 true,
	"offboard-retain":            true,
	"offboard-delete":            true,
}

// requireTaskControlIdentity fails fast — before any state is changed — when a
// task-controlling action runs under an identity that cannot start or stop the
// SDDL-isolated employee scheduled task. Without this gate an interactive
// Administrator run fails halfway (0x80070005 at Start-ScheduledTask) and
// leaves the account disabled.
func requireTaskControlIdentity(action string) error {
	if !taskControlActions[action] {
		return nil
	}
	sid, err := currentProcessSID()
	if err != nil {
		return fmt.Errorf("verify current identity before %s: %w", action, err)
	}
	if !strings.EqualFold(sid, "S-1-5-18") {
		return fmt.Errorf("employee action %s controls the SDDL-isolated WorkAgent3-<SID> scheduled task, which only SYSTEM may start/stop: run it through the loopback Employee Manager service or as SYSTEM", action)
	}
	return nil
}

// cliAuditActions maps the CLI lifecycle actions to the business audit
// vocabulary. CLI invocations are attributed to the subsystem itself; the
// Portal-driven path records the acting administrator instead.
var cliAuditActions = map[string]string{
	"restart":                    "employee.restart",
	"adopt-windows-credential":   "employee.windows_credential.adopt",
	"rotate-windows-credential":  "employee.windows_credential.rotate",
	"backup-windows-credential":  "employee.windows_credential.backup",
	"restore-windows-credential": "employee.windows_credential.restore",
	"add":                        audit.ActionEmployeeProvision,
	"enable":                     audit.ActionEmployeeEnable,
	"disable":                    audit.ActionEmployeeDisable,
	"reset-password":             audit.ActionEmployeePasswordReset,
	"set-limits":                 audit.ActionEmployeeLimitsUpdate,
	"offboard-retain":            audit.ActionEmployeeOffboardRetain,
	"repair":                     audit.ActionEmployeeRepair,
	"rename-windows":             audit.ActionEmployeeRename,
	"offboard-delete":            audit.ActionEmployeeOffboardDelete,
	"grant-admin":                audit.ActionEmployeeAdminGrant,
	"revoke-admin":               audit.ActionEmployeeAdminRevoke,
}

// recordCLIAudit writes the terminal business audit event for a CLI lifecycle
// action. Recording never fails the action itself.
func recordCLIAudit(ctx context.Context, sink audit.Sink, action, username string, operation error) {
	auditAction, ok := cliAuditActions[action]
	if !ok {
		return
	}
	audit.RecordCLI(ctx, sink, "employee-manager", auditAction, username, operation, nil)
}

// usageDrainInterval paces the gateway usage queue consumer. The queue retains
// records only briefly upstream, so the interval stays well under a minute.
const usageDrainInterval = time.Second

// runUsageDrain is the single consumer of the gateway usage queue (the
// endpoint pops records on read). It runs for the lifetime of the service
// process; a failed cycle is logged and retried at the next tick, with
// un-persisted records retried from the drainer's buffer before new pops.
func runUsageDrain(ctx context.Context, drainer *modelgateway.UsageDrainer, interval time.Duration) {
	drain := func() {
		persisted, skipped, err := drainer.Drain(ctx)
		if err != nil {
			log.Printf("Gateway usage drain failed after %d records: %v", persisted, err)
		} else if persisted > 0 || skipped > 0 {
			log.Printf("Gateway usage drain persisted %d records (%d skipped as unmanaged)", persisted, skipped)
		}
	}
	drain()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			drain()
		}
	}
}

func serveManager(ctx context.Context, address, tokenPath string, service *employeemanager.Service, config managerConfig) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		return errors.New("Employee Manager must listen on an exact 127.0.0.1 address")
	}
	if !filepath.IsAbs(tokenPath) {
		return errors.New("absolute --token-file is required in service mode")
	}
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		return fmt.Errorf("read Employee Manager token: %w", err)
	}
	secret := strings.TrimSpace(string(token))
	zero(token)
	if secret == "" {
		return errors.New("Employee Manager token is empty")
	}
	resources, err := employeemanager.NewRuntimeResources(config.RuntimePolicy, config.PortalURL, secret, filepath.Join(filepath.Dir(config.DatabasePath), "runtime-wakeups.json"), service.EnsureRuntime, service.Lifecycle.Platform.StopInstalledRuntime)
	if err != nil {
		return err
	}
	go resources.Run(ctx)
	if service.ProfessionalDatabase != nil && service.ProfessionalDatabaseURL != "http://"+address+"/professional-database/mcp" {
		return errors.New("professional database endpoint must match Employee Manager listener")
	}
	server := &http.Server{Addr: address, Handler: employeemanager.Handler(service, secret), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 2 * time.Minute}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func loadManagerConfig(path string) (managerConfig, error) {
	file, err := os.Open(path)
	if err != nil {
		return managerConfig{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024))
	decoder.DisallowUnknownFields()
	config := managerConfig{RuntimePolicy: employeemanager.RuntimePolicy{MaxRunningRuntimes: 20, IdleMinutes: 30}}
	if err := decoder.Decode(&config); err != nil {
		return managerConfig{}, fmt.Errorf("decode Employee Manager configuration: %w", err)
	}
	if config.RuntimePolicy.MaxRunningRuntimes < 0 || config.RuntimePolicy.MaxRunningRuntimes > 10000 || config.RuntimePolicy.IdleMinutes < 0 || config.RuntimePolicy.IdleMinutes > 10080 {
		return managerConfig{}, errors.New("invalid runtime policy")
	}
	for _, path := range []string{config.DatabasePath, config.DataRootBase, config.UserHostExecutable, config.HarnessCommand, config.HarnessProfileSource, config.ManagedSkillsRoot, config.CredentialRoot, config.LauncherExecutable, config.LaunchManifestRoot} {
		if !filepath.IsAbs(path) {
			return managerConfig{}, errors.New("Employee Manager paths must be absolute")
		}
	}
	if config.ManagedToolsRoot != "" && !filepath.IsAbs(config.ManagedToolsRoot) {
		return managerConfig{}, errors.New("managed tools root must be absolute")
	}
	if config.PublishedPythonCommand != "" && !filepath.IsAbs(config.PublishedPythonCommand) {
		return managerConfig{}, errors.New("published Python command must be absolute")
	}
	if config.ManagedToolsRoot != "" {
		if err := verifyManagedTools(config.ManagedToolsRoot); err != nil {
			return managerConfig{}, err
		}
	}
	if strings.TrimSpace(config.Profile) == "" || strings.TrimSpace(config.PortalURL) == "" {
		return managerConfig{}, errors.New("Harness profile and Portal URL are required")
	}
	return config, nil
}

// managedToolRecord is the pinned OfficeCLI record shipped with the release
// (release/managed-tools/officecli/manifest.json). It fixes the tool version,
// its license, and the expected binary hash, plus the pinned plugins the
// managed install must carry (the Office→PDF preview needs the exporter
// plugin).
type managedToolRecord struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Name          string                `json:"name"`
	Version       string                `json:"version"`
	License       string                `json:"license"`
	SHA256        string                `json:"sha256"`
	Plugins       []managedPluginRecord `json:"plugins"`
}

// managedPluginRecord pins one OfficeCLI plugin discovered by officecli.exe
// from the bundled plugins directory. Path is the slash-separated location
// relative to the managed tools root (plugins/<kind>/<ext>/plugin.exe).
type managedPluginRecord struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Version string `json:"version"`
	License string `json:"license"`
	Path    string `json:"path"`
	SHA256  string `json:"sha256"`
}

// verifyManagedTools is the startup gate for the managed OfficeCLI tool: the
// pinned record must be present and well formed, officecli.exe in the managed
// tools root must exist and match the recorded SHA-256, and every pinned
// plugin must be installed at its recorded path with a matching hash.
func verifyManagedTools(root string) error {
	payload, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		return fmt.Errorf("read managed tools manifest: %w", err)
	}
	var record managedToolRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		return fmt.Errorf("decode managed tools manifest: %w", err)
	}
	hash, hashErr := hex.DecodeString(record.SHA256)
	if record.SchemaVersion != 1 || record.Name != "OfficeCLI" || strings.TrimSpace(record.Version) == "" ||
		strings.TrimSpace(record.License) == "" || hashErr != nil || len(hash) != sha256.Size {
		return errors.New("managed tools manifest is invalid")
	}
	if err := verifyManagedFile(root, "officecli.exe", record.SHA256, "managed OfficeCLI binary"); err != nil {
		return err
	}
	if len(record.Plugins) == 0 {
		return errors.New("managed tools manifest records no plugins; the PDF exporter plugin is required for Office preview")
	}
	for _, plugin := range record.Plugins {
		pluginHash, pluginHashErr := hex.DecodeString(plugin.SHA256)
		if strings.TrimSpace(plugin.Name) == "" || strings.TrimSpace(plugin.Kind) == "" ||
			strings.TrimSpace(plugin.Version) == "" || strings.TrimSpace(plugin.License) == "" ||
			!validManagedPluginPath(plugin.Path) || pluginHashErr != nil || len(pluginHash) != sha256.Size {
			return fmt.Errorf("managed tools manifest plugin record %q is invalid", plugin.Name)
		}
		if err := verifyManagedFile(root, plugin.Path, plugin.SHA256, "managed OfficeCLI plugin "+plugin.Name); err != nil {
			return err
		}
	}
	return nil
}

// validManagedPluginPath accepts only slash-separated relative paths that stay
// inside the managed tools root.
func validManagedPluginPath(path string) bool {
	if path == "" || strings.Contains(path, "\\") || strings.HasPrefix(path, "/") || strings.Contains(path, ":") {
		return false
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(path)))
	return clean == path && clean != "." && clean != ".." && !strings.HasPrefix(clean, "../")
}

// verifyManagedFile requires the file at root/relativePath to be a regular,
// non-symlink file whose SHA-256 matches the pinned digest.
func verifyManagedFile(root, relativePath, expectedSHA256, label string) error {
	target := filepath.Join(root, filepath.FromSlash(relativePath))
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is missing or not a regular file", label)
	}
	file, err := os.Open(target)
	if err != nil {
		return fmt.Errorf("open %s: %w", label, err)
	}
	digest := sha256.New()
	_, copyErr := io.Copy(digest, file)
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if actual := hex.EncodeToString(digest.Sum(nil)); !strings.EqualFold(actual, expectedSHA256) {
		return fmt.Errorf("%s failed integrity verification: expected %s, got %s", label, expectedSHA256, actual)
	}
	return nil
}

func bytesTrimLineEnding(value []byte) []byte {
	for len(value) > 0 && (value[len(value)-1] == '\r' || value[len(value)-1] == '\n') {
		value = value[:len(value)-1]
	}
	return value
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
