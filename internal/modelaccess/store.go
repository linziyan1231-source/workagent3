package modelaccess

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"workagent3/internal/contracts"
)

var (
	ErrModelNotFound     = errors.New("model does not exist")
	ErrModelUnauthorized = errors.New("model is not authorized")
	ErrDownstreamKey     = errors.New("downstream key is invalid")
)

type Health = contracts.ModelHealth

const (
	Healthy     = contracts.ModelHealthy
	Degraded    = contracts.ModelDegraded
	Unavailable = contracts.ModelUnavailable
	Unknown     = contracts.ModelUnknown
)

type Model = contracts.Model
type Authorization = contracts.ModelAuthorization
type AuthorizedModel = contracts.AuthorizedModel

type DownstreamKey struct {
	ID        string    `json:"id"`
	Token     string    `json:"token"`
	SID       string    `json:"-"`
	ModelIDs  []string  `json:"modelIds"`
	CreatedAt time.Time `json:"createdAt"`
}

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open model access database: %w", err)
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
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS model_catalog (
  model_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  input_price_per_million REAL CHECK (input_price_per_million >= 0),
  output_price_per_million REAL CHECK (output_price_per_million >= 0),
  health TEXT NOT NULL CHECK (health IN ('healthy', 'degraded', 'unavailable', 'unknown'))
);
CREATE TABLE IF NOT EXISTS model_authorizations (
  sid TEXT NOT NULL CHECK (sid LIKE 'S-1-%'),
  model_id TEXT NOT NULL REFERENCES model_catalog(model_id) ON DELETE CASCADE,
  authorized INTEGER NOT NULL CHECK (authorized IN (0, 1)),
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (sid, model_id)
);
CREATE TABLE IF NOT EXISTS model_downstream_keys (
  key_id TEXT PRIMARY KEY,
  sid TEXT NOT NULL CHECK (sid LIKE 'S-1-%'),
  token_digest BLOB NOT NULL UNIQUE CHECK (length(token_digest) = 32),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS model_downstream_key_models (
  key_id TEXT NOT NULL REFERENCES model_downstream_keys(key_id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES model_catalog(model_id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, model_id)
);
`)
	if err != nil {
		return fmt.Errorf("migrate model access database: %w", err)
	}
	return nil
}

func (s *Store) UpsertModel(ctx context.Context, model Model) error {
	if err := validateModel(model); err != nil {
		return err
	}
	aliases, err := json.Marshal(model.Aliases)
	if err != nil {
		return fmt.Errorf("encode model aliases: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO model_catalog(model_id, provider_id, display_name, aliases_json, context_window,
  input_price_per_million, output_price_per_million, health)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(model_id) DO UPDATE SET provider_id = excluded.provider_id,
  display_name = excluded.display_name, aliases_json = excluded.aliases_json,
  context_window = excluded.context_window, input_price_per_million = excluded.input_price_per_million,
  output_price_per_million = excluded.output_price_per_million, health = excluded.health`,
		model.ID, model.ProviderID, model.DisplayName, string(aliases), model.ContextWindow,
		model.InputPricePerMillion, model.OutputPricePerMillion, model.Health)
	if err != nil {
		return fmt.Errorf("upsert model catalog: %w", err)
	}
	return nil
}

func (s *Store) SetAuthorization(ctx context.Context, sid, modelID string, authorized bool, reason string) error {
	if err := validateSID(sid); err != nil {
		return err
	}
	if strings.TrimSpace(modelID) == "" {
		return errors.New("model ID is required")
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM model_catalog WHERE model_id = ?)`, modelID).Scan(&exists); err != nil {
		return fmt.Errorf("look up model catalog: %w", err)
	}
	if !exists {
		return ErrModelNotFound
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO model_authorizations(sid, model_id, authorized, reason) VALUES(?, ?, ?, ?)
ON CONFLICT(sid, model_id) DO UPDATE SET authorized = excluded.authorized, reason = excluded.reason`,
		sid, modelID, authorized, strings.TrimSpace(reason))
	if err != nil {
		return fmt.Errorf("set model authorization: %w", err)
	}
	return nil
}

func (s *Store) Authorized(ctx context.Context, sid, modelID string) (bool, error) {
	var authorized bool
	err := s.db.QueryRowContext(ctx, `
SELECT authorized FROM model_authorizations WHERE sid = ? AND model_id = ?`, sid, modelID).Scan(&authorized)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read model authorization: %w", err)
	}
	return authorized, nil
}

func (s *Store) ListAuthorized(ctx context.Context, sid string) ([]AuthorizedModel, error) {
	if err := validateSID(sid); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT c.model_id, c.provider_id, c.display_name, c.aliases_json, c.context_window,
  c.input_price_per_million, c.output_price_per_million, c.health,
  COALESCE(a.authorized, 0), COALESCE(a.reason, 'not_granted')
FROM model_catalog c LEFT JOIN model_authorizations a
  ON a.model_id = c.model_id AND a.sid = ?
ORDER BY c.provider_id, c.display_name, c.model_id`, sid)
	if err != nil {
		return nil, fmt.Errorf("list authorized models: %w", err)
	}
	defer rows.Close()
	models := make([]AuthorizedModel, 0)
	for rows.Next() {
		var model AuthorizedModel
		var aliases string
		if err := rows.Scan(&model.ID, &model.ProviderID, &model.DisplayName, &aliases, &model.ContextWindow,
			&model.InputPricePerMillion, &model.OutputPricePerMillion, &model.Health,
			&model.Authorization.Authorized, &model.Authorization.Reason); err != nil {
			return nil, fmt.Errorf("scan authorized model: %w", err)
		}
		model.Authorization.ModelID = model.ID
		if err := json.Unmarshal([]byte(aliases), &model.Aliases); err != nil {
			return nil, fmt.Errorf("decode model aliases: %w", err)
		}
		models = append(models, model)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate authorized models: %w", err)
	}
	return models, nil
}

func (s *Store) IssueDownstreamKey(ctx context.Context, sid string, modelIDs []string) (DownstreamKey, error) {
	if err := validateSID(sid); err != nil {
		return DownstreamKey{}, err
	}
	modelIDs = uniqueModelIDs(modelIDs)
	if len(modelIDs) == 0 {
		return DownstreamKey{}, errors.New("at least one model is required")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return DownstreamKey{}, fmt.Errorf("begin downstream key issue: %w", err)
	}
	defer tx.Rollback()
	for _, modelID := range modelIDs {
		var authorized bool
		err := tx.QueryRowContext(ctx, `SELECT authorized FROM model_authorizations
WHERE sid = ? AND model_id = ?`, sid, modelID).Scan(&authorized)
		if errors.Is(err, sql.ErrNoRows) || !authorized {
			return DownstreamKey{}, ErrModelUnauthorized
		}
		if err != nil {
			return DownstreamKey{}, fmt.Errorf("read model authorization: %w", err)
		}
	}
	id, err := randomText(12)
	if err != nil {
		return DownstreamKey{}, err
	}
	secret, err := randomText(32)
	if err != nil {
		return DownstreamKey{}, err
	}
	token := "wak_" + id + "." + secret
	digest := sha256.Sum256([]byte(token))
	createdAt := s.now().UTC()
	if _, err := tx.ExecContext(ctx, `INSERT INTO model_downstream_keys(key_id, sid, token_digest, created_at)
VALUES(?, ?, ?, ?)`, id, sid, digest[:], createdAt.Unix()); err != nil {
		return DownstreamKey{}, fmt.Errorf("persist downstream key: %w", err)
	}
	for _, modelID := range modelIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO model_downstream_key_models(key_id, model_id) VALUES(?, ?)`, id, modelID); err != nil {
			return DownstreamKey{}, fmt.Errorf("scope downstream key: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return DownstreamKey{}, fmt.Errorf("commit downstream key issue: %w", err)
	}
	return DownstreamKey{ID: id, Token: token, SID: sid, ModelIDs: modelIDs, CreatedAt: createdAt}, nil
}

func (s *Store) AuthorizeDownstreamKey(ctx context.Context, token, modelID string) (string, error) {
	digest := sha256.Sum256([]byte(token))
	var sid string
	var expected []byte
	err := s.db.QueryRowContext(ctx, `
SELECT k.sid, k.token_digest FROM model_downstream_keys k
JOIN model_downstream_key_models m ON m.key_id = k.key_id
WHERE k.token_digest = ? AND k.revoked_at IS NULL AND m.model_id = ?`, digest[:], modelID).Scan(&sid, &expected)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrDownstreamKey
	}
	if err != nil {
		return "", fmt.Errorf("authorize downstream key: %w", err)
	}
	if len(expected) != sha256.Size || subtle.ConstantTimeCompare(expected, digest[:]) != 1 {
		return "", ErrDownstreamKey
	}
	return sid, nil
}

func (s *Store) RevokeDownstreamKey(ctx context.Context, sid, keyID string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE model_downstream_keys SET revoked_at = ?
WHERE key_id = ? AND sid = ? AND revoked_at IS NULL`, s.now().UTC().Unix(), keyID, sid)
	if err != nil {
		return fmt.Errorf("revoke downstream key: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return ErrDownstreamKey
	}
	return nil
}

func randomText(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate downstream key: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func uniqueModelIDs(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func validateSID(sid string) error {
	if !strings.HasPrefix(sid, "S-1-") {
		return errors.New("model access SID is invalid")
	}
	return nil
}

func validateModel(model Model) error {
	if strings.TrimSpace(model.ID) == "" || strings.TrimSpace(model.ProviderID) == "" || strings.TrimSpace(model.DisplayName) == "" {
		return errors.New("model ID, provider ID, and display name are required")
	}
	if model.ContextWindow <= 0 {
		return errors.New("model context window must be positive")
	}
	if model.Health != Healthy && model.Health != Degraded && model.Health != Unavailable && model.Health != Unknown {
		return errors.New("model health is invalid")
	}
	for _, alias := range model.Aliases {
		if strings.TrimSpace(alias) == "" {
			return errors.New("model aliases cannot be empty")
		}
	}
	return nil
}
