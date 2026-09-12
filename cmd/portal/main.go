package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workagent3/internal/acpcatalog"
	"workagent3/internal/audit"
	"workagent3/internal/auth"
	"workagent3/internal/chatforward"
	"workagent3/internal/collaboration"
	"workagent3/internal/feedback"
	"workagent3/internal/imdelivery"
	"workagent3/internal/marketplace"
	"workagent3/internal/modelaccess"
	"workagent3/internal/nativeauth"
	"workagent3/internal/notifications"
	"workagent3/internal/portal"
	"workagent3/internal/publishedapps"
	"workagent3/internal/quota"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/settings"
	"workagent3/internal/skillmarket"
	"workagent3/internal/speech"
	"workagent3/internal/store"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	address := flag.String("addr", "127.0.0.1:8080", "Portal listen address")
	publicAddress := flag.String("public-addr", "", "Optional direct public HTTP listener preserving client source addresses")
	databasePath := flag.String("db", filepath.Join("data", "portal.db"), "Portal SQLite path")
	modelAccessPath := flag.String("model-access-db", "", "Model Access SQLite path (defaults beside Portal database)")
	quotaPath := flag.String("quota-db", "", "Quota SQLite path (defaults beside Portal database)")
	settingsPath := flag.String("settings-db", "", "Settings SQLite path (defaults beside Portal database)")
	skillMarketPath := flag.String("skill-market-db", "", "Skill Market SQLite path (defaults beside Portal database)")
	collaborationPath := flag.String("collaboration-db", "", "Collaboration SQLite path (defaults beside Portal database)")
	notificationsPath := flag.String("notifications-db", "", "Notifications SQLite path (defaults beside Portal database)")
	auditPath := flag.String("audit-db", "", "Audit SQLite path (defaults beside Portal database)")
	auditRetentionDays := flag.Int("audit-retention-days", 180, "Days to keep audit events before pruning (0 disables retention cleanup)")
	webPath := flag.String("web", filepath.Join("apps", "web", "dist"), "Web distribution directory")
	assistantResources := flag.String("assistant-resources", filepath.Join("release", "assistant-resources"), "managed builtin assistant resource root")
	secureCookie := flag.Bool("secure-cookie", true, "Require HTTPS for the session cookie")
	feedbackPersonal := flag.Int64("feedback-personal-bytes", 100*1024*1024, "Per employee feedback storage limit")
	feedbackTotal := flag.Int64("feedback-total-bytes", 10*1024*1024*1024, "Total feedback storage limit")
	feedbackRetention := flag.Int("feedback-retention-days", 90, "Feedback retention in days")
	appsPublicURL := flag.String("apps-public-url", "", "Public HTTP Portal origin enabling application publishing")
	appsBind := flag.String("apps-bind", "127.0.0.1", "Application content listener bind address")
	appsEmployeeRoot := flag.String("apps-employee-root", "", "Managed employee data root used to verify application network workers")
	appsFirst := flag.Int("apps-port-first", 20000, "First dedicated application port")
	appsLast := flag.Int("apps-port-last", 20999, "Last dedicated application port")
	acpManifest := flag.String("acp-catalog", "", "Immutable approved ACP release manifest")
	acpState := flag.String("acp-state", "", "ACP selection state (defaults beside Portal database)")
	trustedProxies := flag.String("trusted-proxies", "", "Comma-separated trusted proxy CIDRs; empty ignores forwarding headers")
	loginAccountLimit := flag.Int("login-account-limit", 5, "Failed authentications per account in 15 minutes")
	loginIPLimit := flag.Int("login-ip-limit", 20, "Failed authentications per client IP in 15 minutes; 0 disables IP limit")
	harnessModel := flag.String("harness-model", os.Getenv("WORKAGENT_HARNESS_MODEL"), "configured Codex model displayed for the managed Harness provider")
	flag.Parse()

	if err := os.MkdirAll(filepath.Dir(*databasePath), 0o700); err != nil {
		return fmt.Errorf("create Portal data directory: %w", err)
	}
	data, err := store.Open(*databasePath)
	if err != nil {
		return err
	}
	defer data.Close()
	if *acpState == "" {
		*acpState = filepath.Join(filepath.Dir(*databasePath), "acp-catalog.json")
	}
	acpStore, err := acpcatalog.Open(*acpManifest, *acpState)
	if err != nil {
		return err
	}
	feedbackStore, err := feedback.Open(filepath.Join(filepath.Dir(*databasePath), "feedback.db"))
	if err != nil {
		return err
	}
	defer feedbackStore.Close()
	if err = feedbackStore.Configure(feedback.Limits{PersonalBytes: *feedbackPersonal, TotalBytes: *feedbackTotal, SubmissionsPerTenMinutes: 10}); err != nil {
		return err
	}
	if *feedbackRetention < 1 {
		return errors.New("feedback retention must be positive")
	}
	if err = feedbackStore.Prune(context.Background(), time.Now().Add(-time.Duration(*feedbackRetention)*24*time.Hour)); err != nil {
		return err
	}
	if err := bootstrapUser(data); err != nil {
		return err
	}
	if *modelAccessPath == "" {
		*modelAccessPath = filepath.Join(filepath.Dir(*databasePath), "model-access.db")
	}
	if *quotaPath == "" {
		*quotaPath = filepath.Join(filepath.Dir(*databasePath), "quota.db")
	}
	if *settingsPath == "" {
		*settingsPath = filepath.Join(filepath.Dir(*databasePath), "settings.db")
	}
	if *skillMarketPath == "" {
		*skillMarketPath = filepath.Join(filepath.Dir(*databasePath), "skill-market.db")
	}
	if *collaborationPath == "" {
		*collaborationPath = filepath.Join(filepath.Dir(*databasePath), "collaboration.db")
	}
	if *notificationsPath == "" {
		*notificationsPath = filepath.Join(filepath.Dir(*databasePath), "notifications.db")
	}
	if *auditPath == "" {
		*auditPath = filepath.Join(filepath.Dir(*databasePath), "audit.db")
	}
	for _, path := range []string{*modelAccessPath, *quotaPath, *settingsPath, *skillMarketPath, *collaborationPath, *notificationsPath, *auditPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return fmt.Errorf("create module data directory: %w", err)
		}
	}
	models, err := modelaccess.Open(*modelAccessPath)
	if err != nil {
		return err
	}
	defer models.Close()
	if err := bootstrapModels(models, strings.TrimSpace(*harnessModel)); err != nil {
		return err
	}
	quotas, err := quota.Open(*quotaPath, models)
	if err != nil {
		return err
	}
	defer quotas.Close()
	quotas.UseGatewayAccounting()
	clientSettings, err := settings.Open(*settingsPath)
	if err != nil {
		return err
	}
	defer clientSettings.Close()
	market, err := skillmarket.Open(*skillMarketPath)
	if err != nil {
		return err
	}
	defer market.Close()
	sharedMarket, err := marketplace.Open(*skillMarketPath)
	if err != nil {
		log.Fatal(err)
	}
	defer sharedMarket.Close()
	sharedProjects, err := collaboration.Open(*collaborationPath)
	if err != nil {
		return err
	}
	defer sharedProjects.Close()
	notificationStore, err := notifications.Open(*notificationsPath)
	if err != nil {
		return err
	}
	defer notificationStore.Close()
	auditStore, err := audit.Open(*auditPath)
	if err != nil {
		return err
	}
	defer auditStore.Close()
	quotas.SetAudit(auditStore)
	speechProxy, err := speech.NewProxy(
		os.Getenv("WORKAGENT_SPEECH_URL"),
		os.Getenv("WORKAGENT_SPEECH_TOKEN"),
		speech.DefaultMaxAudioBytes,
		speech.DefaultMaxStreamSeconds*time.Second,
	)
	if err != nil {
		return err
	}
	var chatForwardProxy *chatforward.Proxy
	if endpoint := strings.TrimSpace(os.Getenv("WORKAGENT_CHATFORWARD_URL")); endpoint != "" {
		chatForwardProxy, err = chatforward.NewProxy(endpoint, os.Getenv("WORKAGENT_CHATFORWARD_SECRET_FILE"))
		if err != nil {
			return err
		}
	}
	var imGatewayProxy *portal.IMGatewayProxy
	if endpoint := strings.TrimSpace(os.Getenv("WORKAGENT_IM_GATEWAY_URL")); endpoint != "" {
		imGatewayProxy, err = portal.NewIMGatewayProxy(endpoint, os.Getenv("WORKAGENT_IM_ADMIN_TOKEN"))
		if err != nil {
			return err
		}
	}
	var employeeManager *portal.EmployeeManagerClient
	if endpoint := strings.TrimSpace(os.Getenv("WORKAGENT_EMPLOYEE_MANAGER_URL")); endpoint != "" {
		tokenPath := strings.TrimSpace(os.Getenv("WORKAGENT_EMPLOYEE_MANAGER_TOKEN_FILE"))
		if !filepath.IsAbs(tokenPath) {
			return errors.New("absolute Employee Manager token file is required")
		}
		token, readErr := os.ReadFile(tokenPath)
		if readErr != nil {
			return fmt.Errorf("read Employee Manager token: %w", readErr)
		}
		employeeManager, err = portal.NewEmployeeManagerClient(endpoint, string(token))
		for index := range token {
			token[index] = 0
		}
		if err != nil {
			return err
		}
	}

	registry := runtimeapi.NewRegistry()
	if employeeManager != nil {
		registry.SetStarter(employeeManager.EnsureRuntime)
	}
	if err := registerDevelopmentRuntime(data, registry); err != nil {
		return err
	}
	sharedPlatform, err := portal.NewRuntimeSharedProjectPlatform(registry, sharedProjects, employeeManager)
	if err != nil {
		return err
	}
	sharedFiles, err := portal.NewRuntimeSharedFilePlatform(registry)
	if err != nil {
		return err
	}
	sharedTurns, err := portal.NewRuntimeSharedTurnRunner(registry)
	if err != nil {
		return err
	}
	modules := portal.Modules{
		SoftwareVersion: softwareVersion(),
		AcpCatalog:      acpStore,
		Feedback:        feedbackStore,
		LoginPolicy:     store.LoginPolicy{AccountLimit: *loginAccountLimit, IPLimit: *loginIPLimit, Window: 15 * time.Minute, Lockout: 15 * time.Minute},
		ModelAccess:     models, Quota: quotas, SpeechQuota: quotas, SharedRunQuota: quotas, Speech: speechProxy,
		Settings: clientSettings, SkillMarket: market, Marketplace: sharedMarket,
		Collaboration: sharedProjects, SharedProjects: sharedPlatform, SharedFiles: sharedFiles, SharedTurns: sharedTurns,
		Notifications: notificationStore, Audit: auditStore,
	}
	if *loginAccountLimit < 1 || *loginIPLimit < 0 {
		return errors.New("invalid login attempt limits")
	}
	for _, raw := range strings.Split(*trustedProxies, ",") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil {
			return fmt.Errorf("trusted proxy: %w", err)
		}
		modules.RequestSource.TrustedProxies = append(modules.RequestSource.TrustedProxies, prefix)
	}
	if chatForwardProxy != nil {
		modules.ChatForward = chatForwardProxy
		chatQuota, err := chatforward.Open(filepath.Join(filepath.Dir(*databasePath), "chatforward.db"))
		if err != nil {
			return err
		}
		defer chatQuota.Close()
		modules.ChatGPTPro = chatQuota
		chatForwardProxy.SetQuota(chatQuota, func(ctx context.Context, sid string) bool {
			user, err := data.UserBySID(ctx, sid)
			return err == nil && !user.Disabled && !user.Offboarded
		})
	}
	if imGatewayProxy != nil {
		modules.IM = imGatewayProxy
	}
	if employeeManager != nil {
		modules.EmployeeManagement = employeeManager
		modules.ProfessionalDatabase = employeeManager
		modules.Storage = employeeManager
		modules.SharedTrash = employeeManager
	}
	if *appsPublicURL != "" {
		if !filepath.IsAbs(*appsEmployeeRoot) {
			return errors.New("apps-employee-root must name the absolute managed employee data root")
		}
		appsStore, err := publishedapps.Open(filepath.Join(filepath.Dir(*databasePath), "published-apps.db"), *appsFirst, *appsLast)
		if err != nil {
			return err
		}
		defer appsStore.Close()
		modules.PublishedApps = portal.PublishedAppsConfig{Store: appsStore, PublicURL: strings.TrimRight(*appsPublicURL, "/"), BindHost: *appsBind, EmployeeRoot: *appsEmployeeRoot}
	}
	server, err := portal.NewWithModules(data, registry, *secureCookie, modules)
	if err != nil {
		return err
	}
	web, err := fs.Sub(os.DirFS(*webPath), ".")
	if err := server.StartPublishedApps(); err != nil {
		return err
	}
	defer server.ClosePublishedApps()
	if err != nil {
		return fmt.Errorf("open Web distribution: %w", err)
	}
	if _, err := fs.Stat(web, "index.html"); err != nil {
		return fmt.Errorf("Web distribution is not built: %w", err)
	}
	if !filepath.IsAbs(*assistantResources) {
		absolute, err := filepath.Abs(*assistantResources)
		if err != nil {
			return fmt.Errorf("resolve assistant resources: %w", err)
		}
		*assistantResources = absolute
	}
	avatars, err := fs.Sub(os.DirFS(*assistantResources), "avatars")
	if err != nil {
		return fmt.Errorf("open assistant avatar resources: %w", err)
	}
	if _, err := fs.ReadDir(avatars, "."); err != nil {
		return fmt.Errorf("read assistant avatar resources: %w", err)
	}

	root := http.NewServeMux()
	root.Handle("/internal/runtime/acp-catalog", server.AcpCatalogRuntimeHandler())
	root.Handle("/internal/runtime/published-apps/network", server.PublishedAppsNetworkHandler())
	if chatForwardProxy != nil {
		root.Handle("/internal/chatforward/quota/", chatForwardProxy.CallbackHandler())
	}
	root.Handle("/internal/runtime/lease", runtimeapi.LeaseHandler(registry, data))
	if employeeManager != nil {
		root.Handle("/internal/runtime/control", employeeManager.RuntimeControl(registry))
	}
	root.Handle("/internal/runtime/quota/", quota.RuntimeHandler(quotas, data))
	root.Handle("/internal/runtime/audit", audit.RuntimeHandler(auditStore, data))
	root.Handle("/internal/runtime/notifications", notifications.RuntimeHandler(notificationStore, data))
	root.Handle("/internal/runtime/collaboration", server.SharedChannelHandler())
	root.Handle("/internal/runtime/market-capabilities", server.MarketRuntimeHandler())
	root.Handle("/internal/runtime/shared-trash", server.SharedTrashRuntimeHandler())
	if token := os.Getenv("WORKAGENT_IM_DELIVERY_TOKEN"); token != "" {
		imHandler, err := imdelivery.NewHandler(registry, token)
		if err != nil {
			return err
		}
		root.Handle("/internal/im/deliver", imHandler)
		directoryHandler, err := imdelivery.NewDirectoryHandler(data, token)
		if err != nil {
			return err
		}
		root.Handle("/internal/im/employees/", directoryHandler)
	}
	root.Handle("/assets/puxin-builtin-assistants/", portal.AssistantAvatarHandler(avatars))
	root.Handle("/", server.HandlerWithWeb(portal.SPAHandler(web)))
	httpServer := &http.Server{
		Addr:              *address,
		Handler:           root,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	var publicServer *http.Server
	if *publicAddress != "" {
		listener, err := net.Listen("tcp", *publicAddress)
		if err != nil {
			return err
		}
		publicServer = &http.Server{Handler: publicPortalHandler(root), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 2 * time.Minute}
		defer publicServer.Close()
		go func() {
			if err := publicServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("Portal public listener: %v", err)
				_ = httpServer.Close()
			}
		}()
		log.Printf("WorkAgent public HTTP listening on %s", *publicAddress)
	}
	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go server.RunOwnershipTransferRecovery(shutdownContext, 5*time.Second)
	go server.RunSharedQuotaRecovery(shutdownContext, 5*time.Second)
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-shutdownContext.Done():
				return
			case <-ticker.C:
				if err := feedbackStore.Prune(shutdownContext, time.Now().Add(-time.Duration(*feedbackRetention)*24*time.Hour)); err != nil {
					log.Printf("feedback retention: %v", err)
				}
			}
		}
	}()
	personalTaskRecoveryDone := make(chan struct{})
	go func() {
		defer close(personalTaskRecoveryDone)
		server.RunPersonalTaskRecovery(shutdownContext, 5*time.Second)
	}()
	defer func() { stop(); <-personalTaskRecoveryDone }()
	if *auditRetentionDays > 0 {
		go runAuditRetention(shutdownContext, auditStore, time.Duration(*auditRetentionDays)*24*time.Hour)
	}
	go func() {
		<-shutdownContext.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if publicServer != nil {
			if err := publicServer.Shutdown(ctx); err != nil {
				log.Printf("Portal public shutdown: %v", err)
			}
		}
		if err := httpServer.Shutdown(ctx); err != nil {
			log.Printf("Portal shutdown: %v", err)
		}
	}()
	log.Printf("WorkAgent Portal listening on %s", *address)
	if err := httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// runAuditRetention prunes audit events older than the retention window once
// at startup and then daily.
func runAuditRetention(ctx context.Context, store *audit.Store, retention time.Duration) {
	prune := func() {
		cutoff := time.Now().Add(-retention)
		removed, err := store.Prune(ctx, cutoff)
		if err != nil {
			log.Printf("Audit retention prune failed: %v", err)
		} else if removed > 0 {
			log.Printf("Audit retention pruned %d events older than %s", removed, cutoff.Format(time.RFC3339))
		}
	}
	prune()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prune()
		}
	}
}

func bootstrapModels(models *modelaccess.Store, harnessModel string) error {
	if !nativeauth.ValidModel(harnessModel) {
		// The managed Harness provider must display the real configured Codex
		// model (= employee-manager modelGateway.codexModel), not a placeholder.
		return errors.New("managed Harness model is required: set -harness-model or WORKAGENT_HARNESS_MODEL to the configured Codex model (see docs/employee-manager.config.example.json)")
	}
	ctx := context.Background()
	// The catalog seed is shared with the Employee Manager provision path
	// (modelaccess.SeedCatalog); per-SID authorizations and quota budgets are
	// seeded at provision/repair time, not here — this bootstrap only covers
	// the optional WORKAGENT_BOOTSTRAP_* administrator below.
	if err := modelaccess.SeedCatalog(ctx, models, harnessModel); err != nil {
		return err
	}
	sid := strings.TrimSpace(os.Getenv("WORKAGENT_BOOTSTRAP_SID"))
	for _, modelID := range strings.Split(os.Getenv("WORKAGENT_BOOTSTRAP_MODEL_IDS"), ",") {
		modelID = strings.TrimSpace(modelID)
		if modelID == "" {
			continue
		}
		if sid == "" {
			return errors.New("bootstrap SID is required with bootstrap model IDs")
		}
		if err := models.SetAuthorization(ctx, sid, modelID, true, ""); err != nil {
			return fmt.Errorf("grant bootstrap model %s: %w", modelID, err)
		}
	}
	return nil
}

func bootstrapUser(data *store.Store) error {
	username := os.Getenv("WORKAGENT_BOOTSTRAP_USERNAME")
	if username == "" {
		return nil
	}
	if _, err := data.UserByUsername(context.Background(), username); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("look up bootstrap user: %w", err)
	}
	password := os.Getenv("WORKAGENT_BOOTSTRAP_PASSWORD")
	sid := os.Getenv("WORKAGENT_BOOTSTRAP_SID")
	if password == "" || sid == "" {
		return errors.New("bootstrap password and SID are required with bootstrap username")
	}
	hash, err := auth.HashPassword([]byte(password))
	if err != nil {
		return fmt.Errorf("hash bootstrap password: %w", err)
	}
	if _, err := data.CreateUser(context.Background(), username, sid, hash); err != nil {
		return fmt.Errorf("create bootstrap user: %w", err)
	}
	return nil
}

func registerDevelopmentRuntime(data *store.Store, registry *runtimeapi.Registry) error {
	if credential := os.Getenv("WORKAGENT_RUNTIME_REGISTRATION_TOKEN"); credential != "" {
		if err := data.AuthorizeRuntime(context.Background(), os.Getenv("WORKAGENT_RUNTIME_SID"), credential); err != nil {
			return err
		}
	}
	baseURL := os.Getenv("WORKAGENT_RUNTIME_URL")
	if baseURL == "" {
		return nil
	}
	return registry.Register(runtimeapi.Registration{
		SID:       os.Getenv("WORKAGENT_RUNTIME_SID"),
		BaseURL:   baseURL,
		Token:     os.Getenv("WORKAGENT_RUNTIME_TOKEN"),
		ExpiresAt: time.Now().Add(24 * time.Hour),
	})
}
