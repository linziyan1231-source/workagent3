package store

import (
	"context"
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
	ID           int64  `json:"id"`
	Username     string `json:"username"`
	SID          string `json:"-"`
	PasswordHash string `json:"-"`
	Disabled     bool   `json:"disabled"`
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
  sid TEXT NOT NULL UNIQUE CHECK (sid LIKE 'S-1-%'),
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`)
	if err != nil {
		return fmt.Errorf("migrate portal database: %w", err)
	}
	return nil
}

func (s *Store) CreateUser(ctx context.Context, username, sid, passwordHash string) (User, error) {
	result, err := s.db.ExecContext(ctx, `INSERT INTO users(username, sid, password_hash) VALUES(?, ?, ?)`, username, sid, passwordHash)
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return User{}, fmt.Errorf("read created user id: %w", err)
	}
	return User{ID: id, Username: username, SID: sid, PasswordHash: passwordHash}, nil
}

func (s *Store) UserByUsername(ctx context.Context, username string) (User, error) {
	var user User
	var disabled int
	err := s.db.QueryRowContext(ctx, `SELECT id, username, sid, password_hash, disabled FROM users WHERE username = ?`, username).
		Scan(&user.ID, &user.Username, &user.SID, &user.PasswordHash, &disabled)
	if err != nil {
		return User{}, err
	}
	user.Disabled = disabled != 0
	return user, nil
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
	var disabled int
	err := s.db.QueryRowContext(ctx, `
SELECT u.id, u.username, u.sid, u.password_hash, u.disabled
FROM sessions s JOIN users u ON u.id = s.user_id
WHERE s.token = ? AND s.expires_at > ?`, token, now.Unix()).Scan(&user.ID, &user.Username, &user.SID, &user.PasswordHash, &disabled)
	if err != nil {
		return User{}, err
	}
	user.Disabled = disabled != 0
	if user.Disabled {
		return User{}, errors.New("user is disabled")
	}
	return user, nil
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
}
