package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

var ErrUnsupportedKey = errors.New("unsupported client setting key")

var allowedKeys = map[string]struct{}{
	"acp.promptTimeout":    {},
	"acp.agentIdleTimeout": {},
	"theme.activeId":       {},
	"theme.userThemes":     {},
	"ui.fontSize.chat":     {},
	"ui.fontSize.markdown": {},
	"ui.fontSize.code":     {},
	"channel.telegram":     {},
	"channel.lark":         {},
	"channel.dingtalk":     {},
	"channel.weixin":       {},
	"channel.wecom":        {},
}

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open settings database: %w", err)
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
CREATE TABLE IF NOT EXISTS client_settings (
  sid TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sid, setting_key)
);`)
	if err != nil {
		return fmt.Errorf("migrate settings database: %w", err)
	}
	return nil
}

func IsAllowedKey(key string) bool {
	_, ok := allowedKeys[key]
	return ok
}

func (s *Store) Get(ctx context.Context, sid string, keys []string) (map[string]json.RawMessage, error) {
	result := make(map[string]json.RawMessage)
	for _, key := range keys {
		if !IsAllowedKey(key) {
			continue
		}
		var value string
		err := s.db.QueryRowContext(ctx, `SELECT value_json FROM client_settings WHERE sid = ? AND setting_key = ?`, sid, key).Scan(&value)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read client setting: %w", err)
		}
		result[key] = json.RawMessage(value)
	}
	return result, nil
}

func (s *Store) Put(ctx context.Context, sid string, values map[string]json.RawMessage) error {
	for key, value := range values {
		if !IsAllowedKey(key) {
			return fmt.Errorf("%w: %s", ErrUnsupportedKey, key)
		}
		if string(value) != "null" && !json.Valid(value) {
			return errors.New("invalid client setting value")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin client settings update: %w", err)
	}
	defer tx.Rollback()
	for key, value := range values {
		if string(value) == "null" {
			if _, err := tx.ExecContext(ctx, `DELETE FROM client_settings WHERE sid = ? AND setting_key = ?`, sid, key); err != nil {
				return fmt.Errorf("delete client setting: %w", err)
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO client_settings(sid, setting_key, value_json, updated_at) VALUES(?, ?, ?, ?)
ON CONFLICT(sid, setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, sid, key, string(value), s.now().UnixMilli()); err != nil {
			return fmt.Errorf("persist client setting: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit client settings update: %w", err)
	}
	return nil
}
