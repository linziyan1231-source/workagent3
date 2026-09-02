package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

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
	action := flag.String("action", "", "Optional exact action filter")
	target := flag.String("target", "", "Optional exact target filter")
	correlationID := flag.String("correlation-id", "", "Optional exact correlation ID filter")
	from := flag.String("from", "", "Optional RFC3339 lower time bound")
	to := flag.String("to", "", "Optional RFC3339 upper time bound")
	limit := flag.Int("limit", 100, "Maximum events to export (1-1000)")
	flag.Parse()
	if *limit < 1 || *limit > 1000 {
		return fmt.Errorf("limit must be between 1 and 1000")
	}
	query := contracts.AuditQuery{Actor: *actor, Action: *action, Target: *target, CorrelationID: *correlationID, Limit: *limit}
	var err error
	if query.From, err = parseBound("from", *from); err != nil {
		return err
	}
	if query.To, err = parseBound("to", *to); err != nil {
		return err
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
	events, err := store.List(context.Background(), query)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(audit.RedactEvents(events))
}

func parseBound(name, value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("-%s must be RFC3339: %w", name, err)
	}
	return parsed, nil
}
