package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

func ValidateDisplayName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 64 {
		return "", errors.New("display name must contain between 1 and 64 characters")
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return "", errors.New("display name must not contain control characters")
		}
	}
	return value, nil
}

func (s *Store) UpdateProfile(ctx context.Context, userID int64, displayName string, collaborationEnabled bool) (User, error) {
	name, err := ValidateDisplayName(displayName)
	if err != nil {
		return User{}, err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE users SET display_name=?, collaboration_enabled=? WHERE id=? AND disabled=0`, name, collaborationEnabled, userID)
	if err != nil {
		return User{}, fmt.Errorf("update Portal profile: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return User{}, errors.New("Portal user does not exist")
	}
	return s.UserByID(ctx, userID)
}

func (s *Store) UserByID(ctx context.Context, userID int64) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT id, username, display_name, sid, password_hash, disabled, admin, collaboration_enabled, created_at, last_login_at, offboarded, windows_username FROM users WHERE id=?`, userID))
}
