package store

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type User struct {
	ID                   int64  `json:"id"`
	Username             string `json:"username"`
	DisplayName          string `json:"display_name"`
	SID                  string `json:"-"`
	PasswordHash         string `json:"-"`
	Disabled             bool   `json:"disabled"`
	CollaborationEnabled bool   `json:"collaboration_enabled"`
	CollaborationCapable bool   `json:"collaboration_capable"`
}

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open portal database: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  sid TEXT NOT NULL UNIQUE CHECK (sid LIKE 'S-1-%'),
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  collaboration_enabled INTEGER NOT NULL DEFAULT 0 CHECK (collaboration_enabled IN (0, 1))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS runtime_credentials (
  sid TEXT PRIMARY KEY,
  credential_digest BLOB NOT NULL CHECK (length(credential_digest) = 32)
);
`)
	if err != nil {
		return fmt.Errorf("migrate portal database: %w", err)
	}
	for _, column := range []struct {
		name string
		ddl  string
	}{
		{name: "display_name", ddl: `ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`},
		{name: "collaboration_enabled", ddl: `ALTER TABLE users ADD COLUMN collaboration_enabled INTEGER NOT NULL DEFAULT 0 CHECK (collaboration_enabled IN (0, 1))`},
	} {
		var exists int
		if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pragma_table_info('users') WHERE name=?)`, column.name).Scan(&exists); err != nil {
			return fmt.Errorf("inspect Portal user schema: %w", err)
		}
		if exists == 0 {
			if _, err := s.db.ExecContext(ctx, column.ddl); err != nil {
				return fmt.Errorf("add Portal user %s: %w", column.name, err)
			}
		}
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE users SET display_name=username WHERE trim(display_name)=''`); err != nil {
		return fmt.Errorf("backfill Portal user display names: %w", err)
	}
	return nil
}

func (s *Store) AuthorizeRuntime(ctx context.Context, sid, credential string) error {
	if sid == "" || credential == "" {
		return errors.New("runtime SID and registration credential are required")
	}
	digest := sha256.Sum256([]byte(credential))
	_, err := s.db.ExecContext(ctx, `INSERT INTO runtime_credentials(sid, credential_digest) VALUES(?, ?)
ON CONFLICT(sid) DO UPDATE SET credential_digest = excluded.credential_digest`, sid, digest[:])
	if err != nil {
		return fmt.Errorf("persist runtime credential: %w", err)
	}
	return nil
}

func (s *Store) RuntimeRegistrationAuthorized(ctx context.Context, sid, credential string) bool {
	var expected []byte
	if err := s.db.QueryRowContext(ctx, `SELECT credential_digest FROM runtime_credentials WHERE sid = ?`, sid).Scan(&expected); err != nil {
		return false
	}
	actual := sha256.Sum256([]byte(credential))
	return len(expected) == sha256.Size && subtle.ConstantTimeCompare(actual[:], expected) == 1
}

func (s *Store) CreateUser(ctx context.Context, username, sid, passwordHash string) (User, error) {
	return s.createUser(ctx, username, sid, passwordHash, false)
}

func (s *Store) CreateDisabledUser(ctx context.Context, username, sid, passwordHash string) (User, error) {
	return s.createUser(ctx, username, sid, passwordHash, true)
}

func (s *Store) createUser(ctx context.Context, username, sid, passwordHash string, disabled bool) (User, error) {
	result, err := s.db.ExecContext(ctx, `INSERT INTO users(username, display_name, sid, password_hash, disabled) VALUES(?, ?, ?, ?, ?)`, username, username, sid, passwordHash, disabled)
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return User{}, fmt.Errorf("read created user id: %w", err)
	}
	return User{ID: id, Username: username, DisplayName: username, SID: sid, PasswordHash: passwordHash, Disabled: disabled, CollaborationCapable: true}, nil
}

func (s *Store) UserByUsername(ctx context.Context, username string) (User, error) {
	var user User
	var disabled, collaborationEnabled int
	err := s.db.QueryRowContext(ctx, `SELECT id, username, display_name, sid, password_hash, disabled, collaboration_enabled FROM users WHERE username = ?`, username).
		Scan(&user.ID, &user.Username, &user.DisplayName, &user.SID, &user.PasswordHash, &disabled, &collaborationEnabled)
	if err != nil {
		return User{}, err
	}
	user.Disabled = disabled != 0
	user.CollaborationEnabled = collaborationEnabled != 0
	user.CollaborationCapable = true
	return user, nil
}

func (s *Store) SetUserCredentials(ctx context.Context, id int64, passwordHash string, disabled bool) error {
	result, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ?, disabled = ? WHERE id = ?`, passwordHash, disabled, id)
	if err != nil {
		return fmt.Errorf("update user credentials: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return errors.New("Portal user does not exist")
	}
	return nil
}

func (s *Store) CreateSession(ctx context.Context, token string, userID int64, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)`, token, userID, expiresAt.Unix())
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	return nil
}

func (s *Store) UserBySession(ctx context.Context, token string, now time.Time) (User, error) {
	var user User
	var disabled, collaborationEnabled int
	err := s.db.QueryRowContext(ctx, `
SELECT u.id, u.username, u.display_name, u.sid, u.password_hash, u.disabled, u.collaboration_enabled
FROM sessions s JOIN users u ON u.id = s.user_id
WHERE s.token = ? AND s.expires_at > ?`, token, now.Unix()).Scan(&user.ID, &user.Username, &user.DisplayName, &user.SID, &user.PasswordHash, &disabled, &collaborationEnabled)
	if err != nil {
		return User{}, err
	}
	user.Disabled = disabled != 0
	user.CollaborationEnabled = collaborationEnabled != 0
	user.CollaborationCapable = true
	if user.Disabled {
		return User{}, errors.New("user is disabled")
	}
	return user, nil
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
}
