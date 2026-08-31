package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	databasePath := flag.String("db", "data/audit.db", "Audit SQLite path")
	actor := flag.String("actor", "", "Optional exact actor filter")
	correlationID := flag.String("correlation-id", "", "Optional exact correlation ID filter")
	limit := flag.Int("limit", 100, "Maximum events to export (1-1000)")
	flag.Parse()
	if *limit < 1 || *limit > 1000 {
		return fmt.Errorf("limit must be between 1 and 1000")
	}
	info, err := os.Lstat(*databasePath)
	if err != nil {
		return fmt.Errorf("inspect audit database: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("audit database must be a regular non-symlink file")
	}
	store, err := audit.Open(*databasePath)
	if err != nil {
		return err
	}
	defer store.Close()
	events, err := store.List(context.Background(), contracts.AuditQuery{Actor: *actor, CorrelationID: *correlationID, Limit: *limit})
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(events)
}
