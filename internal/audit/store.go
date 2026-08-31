package audit

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"workagent3/internal/contracts"

	_ "modernc.org/sqlite"
)

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open audit database: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database, now: time.Now}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success','failure','denied')),
  correlation_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events(occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_time ON audit_events(actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_correlation ON audit_events(correlation_id);`)
	if err != nil {
		return fmt.Errorf("migrate audit database: %w", err)
	}
	return nil
}

func (s *Store) Record(ctx context.Context, input contracts.AuditInput) (contracts.AuditEvent, error) {
	input.Actor = strings.TrimSpace(input.Actor)
	input.Target = strings.TrimSpace(input.Target)
	input.Action = strings.TrimSpace(input.Action)
	input.CorrelationID = strings.TrimSpace(input.CorrelationID)
	if err := validate(input); err != nil {
		return contracts.AuditEvent{}, err
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return contracts.AuditEvent{}, fmt.Errorf("create audit event ID: %w", err)
	}
	event := contracts.AuditEvent{
		ID: "audit-" + hex.EncodeToString(random), Actor: input.Actor, Target: input.Target,
		Action: input.Action, Result: input.Result, CorrelationID: input.CorrelationID, OccurredAt: s.now().UTC(),
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO audit_events(id,actor,target,action,result,correlation_id,occurred_at) VALUES(?,?,?,?,?,?,?)`,
		event.ID, event.Actor, event.Target, event.Action, event.Result, event.CorrelationID, event.OccurredAt.UnixMilli())
	if err != nil {
		return contracts.AuditEvent{}, fmt.Errorf("record audit event: %w", err)
	}
	return event, nil
}

func (s *Store) List(ctx context.Context, query contracts.AuditQuery) ([]contracts.AuditEvent, error) {
	if query.Limit <= 0 || query.Limit > 1000 {
		query.Limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,actor,target,action,result,correlation_id,occurred_at
FROM audit_events WHERE (?='' OR actor=?) AND (?='' OR correlation_id=?)
ORDER BY occurred_at DESC,id DESC LIMIT ?`, query.Actor, query.Actor, query.CorrelationID, query.CorrelationID, query.Limit)
	if err != nil {
		return nil, fmt.Errorf("list audit events: %w", err)
	}
	defer rows.Close()
	result := make([]contracts.AuditEvent, 0)
	for rows.Next() {
		var event contracts.AuditEvent
		var occurredAt int64
		if err := rows.Scan(&event.ID, &event.Actor, &event.Target, &event.Action, &event.Result, &event.CorrelationID, &occurredAt); err != nil {
			return nil, fmt.Errorf("scan audit event: %w", err)
		}
		event.OccurredAt = time.UnixMilli(occurredAt).UTC()
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate audit events: %w", err)
	}
	return result, nil
}

func validate(input contracts.AuditInput) error {
	if input.Actor == "" || input.Action == "" || input.CorrelationID == "" {
		return errors.New("audit actor, action, and correlation ID are required")
	}
	if len(input.Actor) > 256 || len(input.Target) > 512 || len(input.Action) > 256 || len(input.CorrelationID) > 128 {
		return errors.New("audit field exceeds limit")
	}
	if strings.ContainsAny(input.Actor+input.Target+input.Action+input.CorrelationID, "\r\n\x00") {
		return errors.New("audit fields contain control characters")
	}
	if input.Result != "success" && input.Result != "failure" && input.Result != "denied" {
		return errors.New("audit result is invalid")
	}
	return nil
}
