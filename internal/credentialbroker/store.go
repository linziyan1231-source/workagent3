package credentialbroker

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound          = errors.New("credential not found")
	ErrCredentialExpired = errors.New("credential expired")
)

type Protector interface {
	Seal([]byte) ([]byte, error)
	Open([]byte) ([]byte, error)
}

type Kind string

const (
	KindCodexNative Kind = "codex_native"
	KindKimiNative  Kind = "kimi_native"
	KindProvider    Kind = "provider"
	KindMCPHeader   Kind = "mcp_header"
	KindMCPEnv      Kind = "mcp_env"
	KindMCPOAuth    Kind = "mcp_oauth"
)

type State string

const (
	StateReady     State = "ready"
	StateNeedsAuth State = "needs_auth"
	StateExpired   State = "expired"
	StateRevoked   State = "revoked"
)

type Input struct {
	ID        string
	Kind      Kind
	Label     string
	Secret    []byte
	State     State
	ExpiresAt *time.Time
}

// Metadata is the only credential representation intended for HTTP APIs. It
// deliberately has no encrypted value, plaintext value, or credential path.
type Metadata struct {
	ID        string     `json:"id"`
	Kind      Kind       `json:"kind"`
	State     State      `json:"state"`
	Label     string     `json:"label"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

type Store struct {
	db        *sql.DB
	protector Protector
	now       func() time.Time
}

func Open(path string, protector Protector) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open credential broker: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database, protector: protector, now: time.Now}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('codex_native','kimi_native','provider','mcp_header','mcp_env','mcp_oauth')),
  label TEXT NOT NULL,
  sealed_value BLOB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','needs_auth','expired','revoked')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`)
	if err != nil {
		return fmt.Errorf("migrate credential broker: %w", err)
	}
	return nil
}

func (s *Store) Put(ctx context.Context, input Input) (Metadata, error) {
	if err := validateInput(input); err != nil {
		return Metadata{}, err
	}
	plain := append([]byte(nil), input.Secret...)
	sealed, err := s.protector.Seal(plain)
	clearBytes(plain)
	if err != nil {
		return Metadata{}, fmt.Errorf("protect credential: %w", err)
	}
	defer clearBytes(sealed)
	stamp := s.now().UTC()
	var expiresAt any
	if input.ExpiresAt != nil {
		expiresAt = input.ExpiresAt.UTC().UnixMilli()
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO credentials(id,kind,label,sealed_value,state,expires_at,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,sealed_value=excluded.sealed_value,
state=excluded.state,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
		input.ID, input.Kind, strings.TrimSpace(input.Label), sealed, input.State, expiresAt, stamp.UnixMilli(), stamp.UnixMilli())
	if err != nil {
		return Metadata{}, fmt.Errorf("store credential: %w", err)
	}
	return s.Metadata(ctx, input.ID)
}

func (s *Store) Metadata(ctx context.Context, id string) (Metadata, error) {
	return scanMetadata(s.db.QueryRowContext(ctx, metadataSelect+` WHERE id=?`, id), s.now())
}

func (s *Store) ListMetadata(ctx context.Context) ([]Metadata, error) {
	rows, err := s.db.QueryContext(ctx, metadataSelect+` ORDER BY label,id`)
	if err != nil {
		return nil, fmt.Errorf("list credential metadata: %w", err)
	}
	defer rows.Close()
	result := make([]Metadata, 0)
	for rows.Next() {
		metadata, err := scanMetadata(rows, s.now())
		if err != nil {
			return nil, err
		}
		result = append(result, metadata)
	}
	return result, rows.Err()
}

func (s *Store) Resolve(ctx context.Context, id string) ([]byte, error) {
	var sealed []byte
	var state State
	var expiresAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT sealed_value,state,expires_at FROM credentials WHERE id=?`, id).Scan(&sealed, &state, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read credential: %w", err)
	}
	defer clearBytes(sealed)
	if state != StateReady || (expiresAt.Valid && !s.now().Before(time.UnixMilli(expiresAt.Int64))) {
		return nil, ErrCredentialExpired
	}
	plain, err := s.protector.Open(sealed)
	if err != nil {
		return nil, fmt.Errorf("unprotect credential: %w", err)
	}
	return plain, nil
}

func (s *Store) Revoke(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE credentials SET state='revoked',sealed_value=X'',updated_at=? WHERE id=?`, s.now().UTC().UnixMilli(), id)
	if err != nil {
		return fmt.Errorf("revoke credential: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return ErrNotFound
	}
	return nil
}

const metadataSelect = `SELECT id,kind,label,state,expires_at,updated_at FROM credentials`

type scanner interface{ Scan(...any) error }

func scanMetadata(row scanner, now time.Time) (Metadata, error) {
	var metadata Metadata
	var expiresAt sql.NullInt64
	var updatedAt int64
	err := row.Scan(&metadata.ID, &metadata.Kind, &metadata.Label, &metadata.State, &expiresAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Metadata{}, ErrNotFound
	}
	if err != nil {
		return Metadata{}, err
	}
	if expiresAt.Valid {
		value := time.UnixMilli(expiresAt.Int64).UTC()
		metadata.ExpiresAt = &value
		if metadata.State == StateReady && !now.Before(value) {
			metadata.State = StateExpired
		}
	}
	metadata.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	return metadata, nil
}

func validateInput(input Input) error {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.Label) == "" || len(input.Label) > 160 || len(input.Secret) == 0 {
		return errors.New("invalid credential")
	}
	switch input.Kind {
	case KindCodexNative, KindKimiNative, KindProvider, KindMCPHeader, KindMCPEnv, KindMCPOAuth:
	default:
		return errors.New("invalid credential kind")
	}
	switch input.State {
	case StateReady, StateNeedsAuth, StateExpired, StateRevoked:
	default:
		return errors.New("invalid credential state")
	}
	return nil
}

func clearBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
