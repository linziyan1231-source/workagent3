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
	"syscall"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/portal"
	"workagent3/internal/runtimeapi"
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

	registry := runtimeapi.NewRegistry()
	if err := registerDevelopmentRuntime(registry); err != nil {
		return err
	}
	server, err := portal.New(data, registry, *secureCookie)
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

	httpServer := &http.Server{
		Addr:              *address,
		Handler:           server.HandlerWithWeb(portal.SPAHandler(web)),
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

func registerDevelopmentRuntime(registry *runtimeapi.Registry) error {
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
