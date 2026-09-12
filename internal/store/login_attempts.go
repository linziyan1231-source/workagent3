package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// LoginPolicy applies to password and remembered-device authentication alike.
type LoginPolicy struct {
	AccountLimit, IPLimit int
	Window, Lockout       time.Duration
}

func DefaultLoginPolicy() LoginPolicy { return LoginPolicy{5, 20, 15 * time.Minute, 15 * time.Minute} }

func (s *Store) LoginBlockedUntil(ctx context.Context, account, ip string, now time.Time) (time.Time, error) {
	var until int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(blocked_until),0) FROM login_attempts WHERE key IN (?,?)`, "account:"+strings.ToLower(account), "ip:"+ip).Scan(&until)
	if until <= now.Unix() {
		return time.Time{}, err
	}
	return time.Unix(until, 0), err
}

func (s *Store) RecordLoginAttempt(ctx context.Context, account, ip string, success bool, now time.Time, policy LoginPolicy) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	account = "account:" + strings.ToLower(account)
	if success {
		_, err = tx.ExecContext(ctx, `DELETE FROM login_attempts WHERE key=?`, account)
	} else {
		for _, entry := range []struct {
			key   string
			limit int
		}{{account, policy.AccountLimit}, {"ip:" + ip, policy.IPLimit}} {
			if entry.key == "ip:" || entry.limit <= 0 {
				continue
			}
			var started, blocked int64
			var count int
			err = tx.QueryRowContext(ctx, `SELECT started_at, failures, blocked_until FROM login_attempts WHERE key=?`, entry.key).Scan(&started, &count, &blocked)
			if err != nil && err != sql.ErrNoRows {
				return err
			}
			if blocked > now.Unix() {
				continue
			}
			if started == 0 || now.Unix() >= started+int64(policy.Window.Seconds()) || blocked != 0 {
				started = now.Unix()
				count = 0
				blocked = 0
			}
			count++
			if count >= entry.limit {
				blocked = now.Add(policy.Lockout).Unix()
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO login_attempts(key,started_at,failures,blocked_until) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET started_at=excluded.started_at,failures=excluded.failures,blocked_until=excluded.blocked_until`, entry.key, started, count, blocked)
			if err != nil {
				return err
			}
		}
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM login_attempts WHERE started_at<? AND blocked_until<=?`, now.Add(-policy.Window).Unix(), now.Unix())
	if err != nil {
		return err
	}
	return tx.Commit()
}
