package notifications

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"workagent3/internal/contracts"

	_ "modernc.org/sqlite"
)

const GlobalTarget = "*"

type Store struct {
	db  *sql.DB
	now func() time.Time

	mu          sync.Mutex
	nextSubID   uint64
	subscribers map[uint64]subscriber
}

type subscriber struct {
	sid string
	ch  chan struct{}
}

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open notifications database: %w", err)
	}
	database.SetMaxOpenConns(1)
	store := &Store{db: database, now: time.Now, subscribers: map[uint64]subscriber{}}
	if err := store.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  target_sid TEXT NOT NULL CHECK (target_sid = '*' OR target_sid LIKE 'S-1-%'),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  deep_link TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_target_time ON notifications(target_sid, published_at DESC);
CREATE TABLE IF NOT EXISTS notification_receipts (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  sid TEXT NOT NULL CHECK (sid LIKE 'S-1-%'),
  read_at INTEGER,
  acknowledged_at INTEGER,
  PRIMARY KEY (notification_id, sid)
);`)
	if err != nil {
		return fmt.Errorf("migrate notifications database: %w", err)
	}
	return nil
}

func (s *Store) Publish(ctx context.Context, input contracts.NotificationInput) (contracts.Notification, error) {
	input.TargetSID = strings.TrimSpace(input.TargetSID)
	input.Kind = strings.TrimSpace(input.Kind)
	input.Title = strings.TrimSpace(input.Title)
	input.Message = strings.TrimSpace(input.Message)
	if err := validateInput(input); err != nil {
		return contracts.Notification{}, err
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return contracts.Notification{}, fmt.Errorf("create notification ID: %w", err)
	}
	now := s.now().UTC()
	var expiresAt any
	if input.ExpiresAt != nil {
		expiresAt = input.ExpiresAt.UTC().UnixMilli()
	}
	notification := contracts.Notification{
		ID: id(input.Kind, idBytes), Kind: input.Kind, Title: input.Title, Message: input.Message,
		DeepLink: input.DeepLink, PublishedAt: now,
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO notifications(id,target_sid,kind,title,message,deep_link,published_at,expires_at)
VALUES(?,?,?,?,?,?,?,?)`, notification.ID, input.TargetSID, input.Kind, input.Title, input.Message, input.DeepLink, now.UnixMilli(), expiresAt)
	if err != nil {
		return contracts.Notification{}, fmt.Errorf("publish notification: %w", err)
	}
	s.notify(input.TargetSID)
	return notification, nil
}

func (s *Store) List(ctx context.Context, sid string, limit int) ([]contracts.Notification, error) {
	if !validSID(sid) {
		return nil, errors.New("valid SID is required")
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT n.id,n.kind,n.title,n.message,n.deep_link,n.published_at,r.read_at,r.acknowledged_at
FROM notifications n
LEFT JOIN notification_receipts r ON r.notification_id=n.id AND r.sid=?
WHERE n.target_sid IN (?, '*')
  AND (n.expires_at IS NULL OR n.expires_at>?)
  AND r.acknowledged_at IS NULL
ORDER BY n.published_at DESC, n.id DESC LIMIT ?`, sid, sid, s.now().UTC().UnixMilli(), limit)
	if err != nil {
		return nil, fmt.Errorf("list notifications: %w", err)
	}
	defer rows.Close()
	result := make([]contracts.Notification, 0)
	for rows.Next() {
		var item contracts.Notification
		var published int64
		var readAt, acknowledgedAt sql.NullInt64
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.Message, &item.DeepLink, &published, &readAt, &acknowledgedAt); err != nil {
			return nil, fmt.Errorf("scan notification: %w", err)
		}
		item.PublishedAt = time.UnixMilli(published).UTC()
		item.ReadAt = optionalTime(readAt)
		item.AcknowledgedAt = optionalTime(acknowledgedAt)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate notifications: %w", err)
	}
	return result, nil
}

func (s *Store) MarkRead(ctx context.Context, sid, notificationID string) error {
	return s.receipt(ctx, sid, notificationID, false)
}

func (s *Store) Acknowledge(ctx context.Context, sid, notificationID string) error {
	return s.receipt(ctx, sid, notificationID, true)
}

func (s *Store) receipt(ctx context.Context, sid, notificationID string, acknowledge bool) error {
	if !validSID(sid) || strings.TrimSpace(notificationID) == "" {
		return contracts.ErrNotificationNotFound
	}
	var exists int
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM notifications WHERE id=? AND target_sid IN (?, '*'))`, notificationID, sid).Scan(&exists); err != nil {
		return fmt.Errorf("authorize notification receipt: %w", err)
	}
	if exists == 0 {
		return contracts.ErrNotificationNotFound
	}
	now := s.now().UTC().UnixMilli()
	var err error
	if acknowledge {
		_, err = s.db.ExecContext(ctx, `INSERT INTO notification_receipts(notification_id,sid,read_at,acknowledged_at) VALUES(?,?,?,?)
ON CONFLICT(notification_id,sid) DO UPDATE SET read_at=COALESCE(notification_receipts.read_at,excluded.read_at), acknowledged_at=excluded.acknowledged_at`, notificationID, sid, now, now)
	} else {
		_, err = s.db.ExecContext(ctx, `INSERT INTO notification_receipts(notification_id,sid,read_at) VALUES(?,?,?)
ON CONFLICT(notification_id,sid) DO UPDATE SET read_at=COALESCE(notification_receipts.read_at,excluded.read_at)`, notificationID, sid, now)
	}
	if err != nil {
		return fmt.Errorf("save notification receipt: %w", err)
	}
	return nil
}

func (s *Store) Subscribe(sid string) (<-chan struct{}, func(), error) {
	if !validSID(sid) {
		return nil, nil, errors.New("valid SID is required")
	}
	s.mu.Lock()
	s.nextSubID++
	key := s.nextSubID
	ch := make(chan struct{}, 1)
	s.subscribers[key] = subscriber{sid: sid, ch: ch}
	s.mu.Unlock()
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			s.mu.Lock()
			delete(s.subscribers, key)
			s.mu.Unlock()
		})
	}
	return ch, cancel, nil
}

func (s *Store) notify(targetSID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sub := range s.subscribers {
		if targetSID != GlobalTarget && sub.sid != targetSID {
			continue
		}
		select {
		case sub.ch <- struct{}{}:
		default:
		}
	}
}

func validateInput(input contracts.NotificationInput) error {
	if input.TargetSID != GlobalTarget && !validSID(input.TargetSID) {
		return errors.New("notification target must be a SID or global")
	}
	if input.Kind == "" || len(input.Kind) > 64 || strings.ContainsAny(input.Kind, "\r\n\t") {
		return errors.New("notification kind is invalid")
	}
	if input.Message == "" || len([]rune(input.Message)) > 4000 || len([]rune(input.Title)) > 200 {
		return errors.New("notification text is invalid")
	}
	if input.DeepLink != "" && !validDeepLink(input.DeepLink) {
		return errors.New("notification deep link must be an application-relative path")
	}
	return nil
}

func validDeepLink(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//") &&
		!strings.HasPrefix(parsed.Path, "//") && !strings.Contains(value, "\\") &&
		parsed.IsAbs() == false && parsed.Host == "" && parsed.User == nil
}

func validSID(value string) bool { return strings.HasPrefix(value, "S-1-") && len(value) <= 184 }

func optionalTime(value sql.NullInt64) *time.Time {
	if !value.Valid {
		return nil
	}
	result := time.UnixMilli(value.Int64).UTC()
	return &result
}

func id(kind string, random []byte) string {
	return kind + "-" + hex.EncodeToString(random)
}
