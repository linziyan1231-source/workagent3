package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"workagent3/internal/imgateway"
	"workagent3/internal/imgateway/weixin"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	address := flag.String("addr", "127.0.0.1:8090", "IM Gateway listen address")
	databasePath := flag.String("db", filepath.Join("data", "im-gateway.db"), "IM Gateway SQLite path")
	credentialRoot := flag.String("credential-root", filepath.Join("data", "im-credentials"), "IM Connector private credential directory")
	portalURL := flag.String("portal-url", "http://127.0.0.1:8080", "Portal internal base URL")
	flag.Parse()

	deliveryToken := os.Getenv("WORKAGENT_IM_DELIVERY_TOKEN")
	adminToken := os.Getenv("WORKAGENT_IM_ADMIN_TOKEN")
	if len(deliveryToken) < 32 || len(adminToken) < 32 {
		return errors.New("WORKAGENT_IM_DELIVERY_TOKEN and WORKAGENT_IM_ADMIN_TOKEN must contain at least 32 bytes")
	}
	if err := os.MkdirAll(filepath.Dir(*databasePath), 0o700); err != nil {
		return fmt.Errorf("create IM Gateway data directory: %w", err)
	}
	store, err := imgateway.Open(*databasePath)
	if err != nil {
		return err
	}
	defer store.Close()
	credentials, err := imgateway.NewFileCredentialStore(*credentialRoot)
	if err != nil {
		return err
	}
	weixinConnector, err := weixin.New(credentials)
	if err != nil {
		return err
	}
	weixinLogin, err := weixin.NewLoginService(credentials)
	if err != nil {
		return err
	}
	registry, err := imgateway.NewFactoryRegistry(imgateway.ConnectorRegistration{
		Descriptor: weixinConnector.Descriptor(),
		New: func() (imgateway.ChannelConnector, error) {
			return weixin.New(credentials)
		},
		Login: weixinLogin.Login,
	})
	if err != nil {
		return err
	}
	delivery, err := imgateway.NewHTTPRuntimeDelivery(*portalURL, deliveryToken)
	if err != nil {
		return err
	}
	directory, err := imgateway.NewHTTPEmployeeDirectory(*portalURL, deliveryToken)
	if err != nil {
		return err
	}
	gateway, err := imgateway.New(store, registry, delivery)
	if err != nil {
		return err
	}
	runContext, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, err := imgateway.NewAdmin(runContext, store, registry, gateway, directory, adminToken)
	if err != nil {
		return err
	}
	if err := admin.StartEnabled(runContext); err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"healthy"}`))
	})
	mux.Handle("/v1/", admin)
	server := &http.Server{Addr: *address, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 2 * time.Minute}
	shutdown, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdown.Done()
		cancel()
		ctx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		admin.Stop(ctx)
		_ = server.Shutdown(ctx)
	}()
	log.Printf("WorkAgent IM Gateway listening on %s", *address)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
