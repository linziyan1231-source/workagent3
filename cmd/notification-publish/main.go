package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/notifications"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	databasePath := flag.String("db", "data/notifications.db", "Notifications SQLite path")
	targetSID := flag.String("target-sid", notifications.GlobalTarget, "Target employee SID, or * for all employees")
	kind := flag.String("kind", "announcement", "Notification kind")
	title := flag.String("title", "", "Notification title")
	message := flag.String("message", "", "Notification message")
	deepLink := flag.String("deep-link", "", "Optional application-relative path")
	expiresIn := flag.Duration("expires-in", 0, "Optional expiry duration, for example 2h")
	flag.Parse()

	if err := os.MkdirAll(filepath.Dir(*databasePath), 0o700); err != nil {
		return fmt.Errorf("create notifications data directory: %w", err)
	}
	store, err := notifications.Open(*databasePath)
	if err != nil {
		return err
	}
	defer store.Close()
	var expiresAt *time.Time
	if *expiresIn > 0 {
		value := time.Now().UTC().Add(*expiresIn)
		expiresAt = &value
	}
	item, err := store.Publish(context.Background(), contracts.NotificationInput{
		TargetSID: *targetSID,
		Kind:      *kind,
		Title:     *title,
		Message:   *message,
		DeepLink:  *deepLink,
		ExpiresAt: expiresAt,
	})
	if err != nil {
		return err
	}
	fmt.Println(item.ID)
	return nil
}
