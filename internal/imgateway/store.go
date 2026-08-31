package imgateway

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
	ErrPairingNotAuthorized = errors.New("external user is not authorized")
	ErrDeliveryInProgress   = errors.New("external message delivery is in progress")
)

type Pairing struct {
	ID                int64     `json:"id"`
	ConnectorID       string    `json:"connector_id"`
	ExternalAccountID string    `json:"external_account_id"`
	ExternalUserID    string    `json:"external_user_id"`
	DisplayName       string    `json:"display_name"`
	TargetSID         string    `json:"target_sid,omitempty"`
	Status            string    `json:"status"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type StoredConnector struct {
	OwnerSID string          `json:"owner_sid"`
	ID       string          `json:"id"`
	Enabled  bool            `json:"enabled"`
	Config   ConnectorConfig `json:"config"`
}

type receiptState struct {
	Status           string
	RuntimeSessionID string
	RuntimeReceiptID string
}

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open IM Gateway database: %w", err)
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

func (s *Store) PutConnector(ctx context.Context, connector StoredConnector) error {
	if !strings.HasPrefix(connector.OwnerSID, "S-1-") || connector.ID == "" || len(connector.Config.Public) == 0 || connector.Config.CredentialRef == "" {
		return errors.New("connector configuration is incomplete")
	}
	enabled := 0
	if connector.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO connector_configs(owner_sid, connector_id, enabled, public_config, credential_ref, updated_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(owner_sid, connector_id) DO UPDATE SET enabled=excluded.enabled, public_config=excluded.public_config, credential_ref=excluded.credential_ref, updated_at=excluded.updated_at`, connector.OwnerSID, connector.ID, enabled, string(connector.Config.Public), connector.Config.CredentialRef, s.now().Unix())
	if err != nil {
		return fmt.Errorf("store connector configuration: %w", err)
	}
	return nil
}

func (s *Store) Connectors(ctx context.Context, ownerSID string) ([]StoredConnector, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT owner_sid, connector_id, enabled, public_config, credential_ref FROM connector_configs WHERE owner_sid=? ORDER BY connector_id`, ownerSID)
	if err != nil {
		return nil, fmt.Errorf("list connector configurations: %w", err)
	}
	defer rows.Close()
	var result []StoredConnector
	for rows.Next() {
		var value StoredConnector
		var enabled int
		var public string
		if err := rows.Scan(&value.OwnerSID, &value.ID, &enabled, &public, &value.Config.CredentialRef); err != nil {
			return nil, err
		}
		value.Enabled = enabled != 0
		value.Config.Public = []byte(public)
		result = append(result, value)
	}
	return result, rows.Err()
}

func (s *Store) AllConnectors(ctx context.Context) ([]StoredConnector, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT owner_sid, connector_id, enabled, public_config, credential_ref FROM connector_configs ORDER BY owner_sid, connector_id`)
	if err != nil {
		return nil, fmt.Errorf("list connector configurations: %w", err)
	}
	defer rows.Close()
	var result []StoredConnector
	for rows.Next() {
		var value StoredConnector
		var enabled int
		var public string
		if err := rows.Scan(&value.OwnerSID, &value.ID, &enabled, &public, &value.Config.CredentialRef); err != nil {
			return nil, err
		}
		value.Enabled = enabled != 0
		value.Config.Public = []byte(public)
		result = append(result, value)
	}
	return result, rows.Err()
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS connector_configs (
	owner_sid TEXT NOT NULL,
	connector_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  public_config TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY(owner_sid, connector_id)
);
CREATE TABLE IF NOT EXISTS pairings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  target_sid TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(connector_id, external_account_id, external_user_id)
);
CREATE TABLE IF NOT EXISTS conversation_mappings (
  connector_id TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,
  target_sid TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(connector_id, external_account_id, external_conversation_id)
);
CREATE TABLE IF NOT EXISTS inbound_receipts (
  connector_id TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','delivered','failed')),
  attempts INTEGER NOT NULL,
  runtime_session_id TEXT NOT NULL DEFAULT '',
  runtime_receipt_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(connector_id, external_account_id, external_message_id)
);`)
	if err != nil {
		return fmt.Errorf("migrate IM Gateway database: %w", err)
	}
	return s.migrateConnectorOwnership(ctx)
}

func (s *Store) migrateConnectorOwnership(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(connector_configs)`)
	if err != nil {
		return err
	}
	hasOwner := false
	for rows.Next() {
		var ordinal, notNull, primaryKey int
		var name, valueType string
		var defaultValue any
		if err := rows.Scan(&ordinal, &name, &valueType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return err
		}
		hasOwner = hasOwner || name == "owner_sid"
	}
	if err := rows.Close(); err != nil || hasOwner {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
ALTER TABLE connector_configs RENAME TO connector_configs_legacy;
CREATE TABLE connector_configs (
  owner_sid TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  public_config TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_sid, connector_id)
);
INSERT INTO connector_configs(owner_sid, connector_id, enabled, public_config, credential_ref, updated_at)
SELECT '', connector_id, enabled, public_config, credential_ref, updated_at FROM connector_configs_legacy;
DROP TABLE connector_configs_legacy;`)
	if err != nil {
		return fmt.Errorf("migrate connector ownership: %w", err)
	}
	return nil
}

func (s *Store) RequestPairing(ctx context.Context, connectorID, accountID string, sender Sender) (Pairing, error) {
	if connectorID == "" || accountID == "" || sender.ID == "" || sender.DisplayName == "" {
		return Pairing{}, errors.New("pairing identity is incomplete")
	}
	now := s.now().Unix()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO pairings(connector_id, external_account_id, external_user_id, display_name, status, created_at, updated_at)
VALUES(?, ?, ?, ?, 'pending', ?, ?)
ON CONFLICT(connector_id, external_account_id, external_user_id) DO UPDATE SET
  display_name=excluded.display_name,
  status=CASE WHEN pairings.status IN ('rejected','revoked') THEN 'pending' ELSE pairings.status END,
  updated_at=excluded.updated_at`, connectorID, accountID, sender.ID, sender.DisplayName, now, now)
	if err != nil {
		return Pairing{}, fmt.Errorf("request pairing: %w", err)
	}
	return s.pairing(ctx, connectorID, accountID, sender.ID)
}

func (s *Store) SetPairingStatus(ctx context.Context, id int64, status, targetSID string) error {
	if status != "approved" && status != "rejected" && status != "revoked" {
		return errors.New("invalid pairing status")
	}
	if status == "approved" && !strings.HasPrefix(targetSID, "S-1-") {
		return errors.New("approved pairing requires target SID")
	}
	if status != "approved" {
		targetSID = ""
	}
	result, err := s.db.ExecContext(ctx, `UPDATE pairings SET status=?, target_sid=?, updated_at=? WHERE id=?`, status, targetSID, s.now().Unix(), id)
	if err != nil {
		return fmt.Errorf("update pairing: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) PendingPairings(ctx context.Context) ([]Pairing, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, connector_id, external_account_id, external_user_id, display_name, target_sid, status, created_at, updated_at FROM pairings WHERE status='pending' ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("list pending pairings: %w", err)
	}
	defer rows.Close()
	var result []Pairing
	for rows.Next() {
		value, err := scanPairing(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func (s *Store) Pairings(ctx context.Context) ([]Pairing, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, connector_id, external_account_id, external_user_id, display_name, target_sid, status, created_at, updated_at FROM pairings ORDER BY updated_at DESC, id DESC`)
	if err != nil {
		return nil, fmt.Errorf("list pairings: %w", err)
	}
	defer rows.Close()
	var result []Pairing
	for rows.Next() {
		value, err := scanPairing(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func (s *Store) PairingsForOwner(ctx context.Context, ownerSID string) ([]Pairing, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.connector_id, p.external_account_id, p.external_user_id, p.display_name, p.target_sid, p.status, p.created_at, p.updated_at FROM pairings p JOIN connector_configs c ON c.connector_id=p.connector_id AND json_extract(c.public_config, '$.account_id')=p.external_account_id WHERE c.owner_sid=? ORDER BY p.updated_at DESC, p.id DESC`, ownerSID)
	if err != nil {
		return nil, fmt.Errorf("list owner pairings: %w", err)
	}
	defer rows.Close()
	var result []Pairing
	for rows.Next() {
		value, err := scanPairing(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func (s *Store) SetOwnerPairingStatus(ctx context.Context, ownerSID string, id int64, status string) error {
	if status != "approved" && status != "rejected" && status != "revoked" {
		return errors.New("invalid pairing status")
	}
	targetSID := ""
	if status == "approved" {
		targetSID = ownerSID
	}
	result, err := s.db.ExecContext(ctx, `UPDATE pairings SET status=?, target_sid=?, updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM connector_configs c WHERE c.owner_sid=? AND c.connector_id=pairings.connector_id AND json_extract(c.public_config, '$.account_id')=pairings.external_account_id)`, status, targetSID, s.now().Unix(), id, ownerSID)
	if err != nil {
		return fmt.Errorf("update owner pairing: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) AuthorizedSID(ctx context.Context, connectorID, accountID, externalUserID string) (string, error) {
	var sid string
	err := s.db.QueryRowContext(ctx, `SELECT target_sid FROM pairings WHERE connector_id=? AND external_account_id=? AND external_user_id=? AND status='approved'`, connectorID, accountID, externalUserID).Scan(&sid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrPairingNotAuthorized
	}
	if err != nil {
		return "", fmt.Errorf("resolve pairing: %w", err)
	}
	return sid, nil
}

func (s *Store) SessionMapping(ctx context.Context, message InboundMessage, targetSID string) (string, error) {
	var sessionID string
	err := s.db.QueryRowContext(ctx, `SELECT runtime_session_id FROM conversation_mappings WHERE connector_id=? AND external_account_id=? AND external_conversation_id=? AND target_sid=?`, message.ConnectorID, message.ExternalAccountID, message.ExternalConversationID, targetSID).Scan(&sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return sessionID, err
}

func (s *Store) BeginReceipt(ctx context.Context, message InboundMessage) (receiptState, bool, error) {
	now := s.now().Unix()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return receiptState{}, false, err
	}
	defer tx.Rollback()
	var state receiptState
	err = tx.QueryRowContext(ctx, `SELECT status, runtime_session_id, runtime_receipt_id FROM inbound_receipts WHERE connector_id=? AND external_account_id=? AND external_message_id=?`, message.ConnectorID, message.ExternalAccountID, message.ExternalMessageID).Scan(&state.Status, &state.RuntimeSessionID, &state.RuntimeReceiptID)
	if err == nil {
		if state.Status == "delivered" {
			return state, true, nil
		}
		if state.Status == "processing" {
			return receiptState{}, false, ErrDeliveryInProgress
		}
		_, err = tx.ExecContext(ctx, `UPDATE inbound_receipts SET status='processing', attempts=attempts+1, last_error='', updated_at=? WHERE connector_id=? AND external_account_id=? AND external_message_id=?`, now, message.ConnectorID, message.ExternalAccountID, message.ExternalMessageID)
	} else if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(ctx, `INSERT INTO inbound_receipts(connector_id, external_account_id, external_message_id, status, attempts, created_at, updated_at) VALUES(?, ?, ?, 'processing', 1, ?, ?)`, message.ConnectorID, message.ExternalAccountID, message.ExternalMessageID, now, now)
	} else {
		return receiptState{}, false, err
	}
	if err != nil {
		return receiptState{}, false, err
	}
	return receiptState{}, false, tx.Commit()
}

func (s *Store) CompleteReceipt(ctx context.Context, message InboundMessage, targetSID string, receipt DeliveryReceipt) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().Unix()
	result, err := tx.ExecContext(ctx, `UPDATE inbound_receipts SET status='delivered', runtime_session_id=?, runtime_receipt_id=?, updated_at=? WHERE connector_id=? AND external_account_id=? AND external_message_id=? AND status='processing'`, receipt.RuntimeSessionID, receipt.RuntimeReceiptID, now, message.ConnectorID, message.ExternalAccountID, message.ExternalMessageID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return errors.New("IM receipt is not processing")
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO conversation_mappings(connector_id, external_account_id, external_conversation_id, target_sid, runtime_session_id, updated_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(connector_id, external_account_id, external_conversation_id) DO UPDATE SET target_sid=excluded.target_sid, runtime_session_id=excluded.runtime_session_id, updated_at=excluded.updated_at`, message.ConnectorID, message.ExternalAccountID, message.ExternalConversationID, targetSID, receipt.RuntimeSessionID, now)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) FailReceipt(ctx context.Context, message InboundMessage, deliveryErr error) error {
	_, err := s.db.ExecContext(ctx, `UPDATE inbound_receipts SET status='failed', last_error=?, updated_at=? WHERE connector_id=? AND external_account_id=? AND external_message_id=? AND status='processing'`, deliveryErr.Error(), s.now().Unix(), message.ConnectorID, message.ExternalAccountID, message.ExternalMessageID)
	return err
}

func (s *Store) pairing(ctx context.Context, connectorID, accountID, userID string) (Pairing, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, connector_id, external_account_id, external_user_id, display_name, target_sid, status, created_at, updated_at FROM pairings WHERE connector_id=? AND external_account_id=? AND external_user_id=?`, connectorID, accountID, userID)
	return scanPairing(row)
}

type rowScanner interface{ Scan(...any) error }

func scanPairing(row rowScanner) (Pairing, error) {
	var value Pairing
	var created, updated int64
	err := row.Scan(&value.ID, &value.ConnectorID, &value.ExternalAccountID, &value.ExternalUserID, &value.DisplayName, &value.TargetSID, &value.Status, &created, &updated)
	value.CreatedAt = time.Unix(created, 0).UTC()
	value.UpdatedAt = time.Unix(updated, 0).UTC()
	return value, err
}
