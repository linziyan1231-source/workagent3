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
	ID                   int64      `json:"id"`
	Username             string     `json:"username"`
	DisplayName          string     `json:"display_name"`
	SID                  string     `json:"-"`
	WindowsUsername      string     `json:"-"`
	PasswordHash         string     `json:"-"`
	Disabled             bool       `json:"disabled"`
	Admin                bool       `json:"admin"`
	Offboarded           bool       `json:"-"`
	CollaborationEnabled bool       `json:"collaboration_enabled"`
	CollaborationCapable bool       `json:"collaboration_capable"`
	CreatedAt            time.Time  `json:"-"`
	LastLoginAt          *time.Time `json:"-"`
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
  admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1)),
  collaboration_enabled INTEGER NOT NULL DEFAULT 0 CHECK (collaboration_enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER,
  offboarded INTEGER NOT NULL DEFAULT 0 CHECK (offboarded IN (0, 1)),
  windows_username TEXT NOT NULL DEFAULT ''
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
		{name: "admin", ddl: `ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1))`},
		{name: "collaboration_enabled", ddl: `ALTER TABLE users ADD COLUMN collaboration_enabled INTEGER NOT NULL DEFAULT 0 CHECK (collaboration_enabled IN (0, 1))`},
		{name: "created_at", ddl: `ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`},
		{name: "last_login_at", ddl: `ALTER TABLE users ADD COLUMN last_login_at INTEGER`},
		{name: "offboarded", ddl: `ALTER TABLE users ADD COLUMN offboarded INTEGER NOT NULL DEFAULT 0 CHECK (offboarded IN (0, 1))`},
		{name: "windows_username", ddl: `ALTER TABLE users ADD COLUMN windows_username TEXT NOT NULL DEFAULT ''`},
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
	if _, err := s.db.ExecContext(ctx, `UPDATE users SET windows_username=username WHERE trim(windows_username)=''`); err != nil {
		return fmt.Errorf("backfill Windows usernames: %w", err)
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
	now := time.Now().UTC()
	result, err := s.db.ExecContext(ctx, `INSERT INTO users(username, display_name, sid, windows_username, password_hash, disabled, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`, username, username, sid, username, passwordHash, disabled, now.Unix())
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return User{}, fmt.Errorf("read created user id: %w", err)
	}
	return User{ID: id, Username: username, DisplayName: username, SID: sid, WindowsUsername: username, PasswordHash: passwordHash, Disabled: disabled, CollaborationCapable: true, CreatedAt: now}, nil
}

func scanUser(scanner interface{ Scan(...any) error }) (User, error) {
	var user User
	var disabled, admin, collaborationEnabled, offboarded int
	var createdAt int64
	var lastLoginAt sql.NullInt64
	if err := scanner.Scan(&user.ID, &user.Username, &user.DisplayName, &user.SID, &user.PasswordHash, &disabled, &admin, &collaborationEnabled, &createdAt, &lastLoginAt, &offboarded, &user.WindowsUsername); err != nil {
		return User{}, err
	}
	user.Disabled = disabled != 0
	user.Admin = admin != 0
	user.Offboarded = offboarded != 0
	user.CollaborationEnabled = collaborationEnabled != 0
	user.CollaborationCapable = true
	user.CreatedAt = time.Unix(createdAt, 0).UTC()
	if lastLoginAt.Valid {
		value := time.Unix(lastLoginAt.Int64, 0).UTC()
		user.LastLoginAt = &value
	}
	return user, nil
}

func (s *Store) UserByUsername(ctx context.Context, username string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT id, username, display_name, sid, password_hash, disabled, admin, collaboration_enabled, created_at, last_login_at, offboarded, windows_username FROM users WHERE username = ?`, username))
}

func (s *Store) UserBySID(ctx context.Context, sid string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT id, username, display_name, sid, password_hash, disabled, admin, collaboration_enabled, created_at, last_login_at, offboarded, windows_username FROM users WHERE sid = ?`, sid))
}

func (s *Store) ListManagedUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, username, display_name, sid, password_hash, disabled, admin, collaboration_enabled, created_at, last_login_at, offboarded, windows_username FROM users WHERE admin=0 ORDER BY username COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
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

func (s *Store) SetWindowsUsername(ctx context.Context, id int64, windowsUsername string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE users SET windows_username=? WHERE id=?`, windowsUsername, id)
	if err != nil {
		return fmt.Errorf("update Windows username: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return errors.New("Portal user does not exist")
	}
	return nil
}

// SetUserEnabled changes the Portal account state and revokes every browser
// session in the same transaction. Disabling an employee therefore takes
// effect for already authenticated browsers as well as future logins.
func (s *Store) SetUserEnabled(ctx context.Context, username string, enabled bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin user state change: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE users SET disabled = ? WHERE username = ? AND (? = 0 OR offboarded = 0)`, !enabled, username, enabled)
	if err != nil {
		return fmt.Errorf("update user state: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return errors.New("Portal user does not exist or is offboarded")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)`, username); err != nil {
		return fmt.Errorf("revoke user sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit user state change: %w", err)
	}
	return nil
}

func (s *Store) SetUserOffboarded(ctx context.Context, username string, offboarded bool) error {
	result, err := s.db.ExecContext(ctx, `UPDATE users SET offboarded=? WHERE username=? AND (?=0 OR disabled=1)`, offboarded, username, offboarded)
	if err != nil {
		return fmt.Errorf("update employee retention state: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return errors.New("employee must be disabled before offboarding")
	}
	return nil
}

// ResetUserPassword rotates only the Portal password. The employee's Windows
// logon secret remains owned by Employee Manager and is never exposed to the
// Portal or browser.
func (s *Store) ResetUserPassword(ctx context.Context, username, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin password reset: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE username = ?`, passwordHash, username)
	if err != nil {
		return fmt.Errorf("reset user password: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return errors.New("Portal user does not exist")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)`, username); err != nil {
		return fmt.Errorf("revoke user sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit password reset: %w", err)
	}
	return nil
}

// SetUserAdmin is called only by the privileged Employee Manager. Revoking
// every browser session makes role changes effective on the next request.
func (s *Store) SetUserAdmin(ctx context.Context, username string, admin bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin administrator role change: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE users SET admin = ? WHERE username = ?`, admin, username)
	if err != nil {
		return fmt.Errorf("update administrator role: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return errors.New("Portal user does not exist")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)`, username); err != nil {
		return fmt.Errorf("revoke user sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit administrator role change: %w", err)
	}
	return nil
}

func (s *Store) CreateSession(ctx context.Context, token string, userID int64, expiresAt time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin session: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)`, token, userID, expiresAt.Unix()); err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET last_login_at=? WHERE id=?`, time.Now().UTC().Unix(), userID); err != nil {
		return fmt.Errorf("record login: %w", err)
	}
	return tx.Commit()
}

func (s *Store) UserBySession(ctx context.Context, token string, now time.Time) (User, error) {
	user, err := scanUser(s.db.QueryRowContext(ctx, `
SELECT u.id, u.username, u.display_name, u.sid, u.password_hash, u.disabled, u.admin, u.collaboration_enabled, u.created_at, u.last_login_at, u.offboarded, u.windows_username
FROM sessions s JOIN users u ON u.id = s.user_id
WHERE s.token = ? AND s.expires_at > ?`, token, now.Unix()))
	if err != nil {
		return User{}, err
	}
	if user.Disabled {
		return User{}, errors.New("user is disabled")
	}
	return user, nil
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
}
