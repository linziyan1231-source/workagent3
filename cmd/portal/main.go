package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/modelaccess"
	"workagent3/internal/portal"
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
	databasePath := flag.String("db", filepath.Join("data", "portal.db"), "Portal SQLite path")
	modelAccessPath := flag.String("model-access-db", "", "Model Access SQLite path (defaults beside Portal database)")
	quotaPath := flag.String("quota-db", "", "Quota SQLite path (defaults beside Portal database)")
	settingsPath := flag.String("settings-db", "", "Settings SQLite path (defaults beside Portal database)")
	skillMarketPath := flag.String("skill-market-db", "", "Skill Market SQLite path (defaults beside Portal database)")
	webPath := flag.String("web", filepath.Join("apps", "web", "dist"), "Web distribution directory")
	secureCookie := flag.Bool("secure-cookie", true, "Require HTTPS for the session cookie")
	flag.Parse()

	if err := os.MkdirAll(filepath.Dir(*databasePath), 0o700); err != nil {
		return fmt.Errorf("create Portal data directory: %w", err)
	}
	data, err := store.Open(*databasePath)
	if err != nil {
		return err
	}
	defer data.Close()
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
	for _, path := range []string{*modelAccessPath, *quotaPath, *settingsPath, *skillMarketPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return fmt.Errorf("create module data directory: %w", err)
		}
	}
	models, err := modelaccess.Open(*modelAccessPath)
	if err != nil {
		return err
	}
	defer models.Close()
	if err := bootstrapModels(models); err != nil {
		return err
	}
	quotas, err := quota.Open(*quotaPath, models)
	if err != nil {
		return err
	}
	defer quotas.Close()
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
	speechProxy, err := speech.NewProxy(
		os.Getenv("WORKAGENT_SPEECH_URL"),
		os.Getenv("WORKAGENT_SPEECH_TOKEN"),
		speech.DefaultMaxAudioBytes,
		speech.DefaultMaxStreamSeconds*time.Second,
	)
	if err != nil {
		return err
	}

	registry := runtimeapi.NewRegistry()
	if err := registerDevelopmentRuntime(data, registry); err != nil {
		return err
	}
	server, err := portal.NewWithModules(data, registry, *secureCookie, portal.Modules{ModelAccess: models, Quota: quotas, Speech: speechProxy, Settings: clientSettings, SkillMarket: market})
	if err != nil {
		return err
	}
	web, err := fs.Sub(os.DirFS(*webPath), ".")
	if err != nil {
		return fmt.Errorf("open Web distribution: %w", err)
	}
	if _, err := fs.Stat(web, "index.html"); err != nil {
		return fmt.Errorf("Web distribution is not built: %w", err)
	}

	root := http.NewServeMux()
	root.Handle("/internal/runtime/lease", runtimeapi.LeaseHandler(registry, data))
	root.Handle("/", server.HandlerWithWeb(portal.SPAHandler(web)))
	httpServer := &http.Server{
		Addr:              *address,
		Handler:           root,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownContext.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
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

func bootstrapModels(models *modelaccess.Store) error {
	ctx := context.Background()
	for _, model := range []modelaccess.Model{
		{ID: "harness-default", ProviderID: "harness", DisplayName: "DeepSeek Harness", Aliases: []string{}, ContextWindow: 128000, Health: modelaccess.Unknown},
		{ID: "codex-native", ProviderID: "codex", DisplayName: "Codex", Aliases: []string{}, ContextWindow: 128000, Health: modelaccess.Unknown},
		{ID: "kimi-native", ProviderID: "kimi", DisplayName: "Kimi", Aliases: []string{}, ContextWindow: 128000, Health: modelaccess.Unknown},
	} {
		if err := models.UpsertModel(ctx, model); err != nil {
			return fmt.Errorf("seed model %s: %w", model.ID, err)
		}
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
