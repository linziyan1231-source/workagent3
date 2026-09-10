package store

import (
	"context"
	"errors"
	"time"
)

// Remembered logins can only mint a new session through the login endpoint.
// They are separate from sessions so logout does not forget this device.
func (s *Store) CreateRememberedLogin(ctx context.Context, token string, userID int64, expires time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO remembered_logins(token, user_id, expires_at) VALUES(?, ?, ?)`, token, userID, expires.Unix())
	return err
}

func (s *Store) UserByRememberedLogin(ctx context.Context, token string, now time.Time) (User, error) {
	user, err := scanUser(s.db.QueryRowContext(ctx, `
SELECT u.id, u.username, u.display_name, u.sid, u.password_hash, u.disabled, u.admin, u.collaboration_enabled, u.created_at, u.last_login_at, u.offboarded, u.windows_username
FROM remembered_logins r JOIN users u ON u.id = r.user_id
WHERE r.token = ? AND r.expires_at > ?`, token, now.Unix()))
	if err != nil {
		return User{}, err
	}
	if user.Disabled {
		return User{}, errors.New("user is disabled")
	}
	return user, nil
}

func (s *Store) DeleteRememberedLogin(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM remembered_logins WHERE token = ?`, token)
	return err
}
