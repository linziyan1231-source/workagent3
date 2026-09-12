package feedback

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"
	"workagent3/internal/auth"
)

var ErrInvalid = errors.New("invalid_feedback")
var ErrCapacity = errors.New("feedback_capacity_exceeded")
var ErrNotFound = errors.New("feedback_not_found")

type Attachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}
type Report struct {
	ID            string       `json:"id"`
	SID           string       `json:"-"`
	Username      string       `json:"username"`
	RequestID     string       `json:"requestId"`
	Module        string       `json:"module"`
	Description   string       `json:"description"`
	Steps         string       `json:"steps"`
	CorrelationID string       `json:"correlationId"`
	Version       string       `json:"version"`
	Status        string       `json:"status"`
	SavedAt       time.Time    `json:"savedAt"`
	Attachments   []Attachment `json:"attachments"`
}
type Upload struct {
	Name, Type string
	Data       []byte
}
type Limits struct {
	PersonalBytes, TotalBytes int64
	SubmissionsPerTenMinutes  int64
}

func DefaultLimits() Limits { return Limits{100 * 1024 * 1024, 10 * 1024 * 1024 * 1024, 10} }

type Store struct {
	db     *sql.DB
	root   string
	mu     sync.Mutex
	limits Limits
}

func Open(path string) (*Store, error) {
	root := filepath.Join(filepath.Dir(path), "feedback-attachments")
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,sid TEXT NOT NULL,request_id TEXT NOT NULL,saved_at INTEGER NOT NULL,bytes INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(sid,request_id));`)
	if err != nil {
		db.Close()
		return nil, err
	}
	if _, err = db.Exec(`CREATE TABLE IF NOT EXISTS attachment_journal(id TEXT PRIMARY KEY)`); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db, root: root, limits: DefaultLimits()}
	if err = s.recoverAttachments(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Configure(limits Limits) error {
	if limits.PersonalBytes < 4*1024*1024 || limits.TotalBytes < limits.PersonalBytes || limits.SubmissionsPerTenMinutes < 1 {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.limits = limits
	return nil
}
func (s *Store) Close() error { return s.db.Close() }
func (s *Store) Create(ctx context.Context, r Report, uploads []Upload) (Report, error) {
	if r.SID == "" || len(r.RequestID) < 8 || len(r.RequestID) > 128 || r.Description == "" || utf8.RuneCountInString(r.Description) > 2000 || len(r.Steps) > 16000 || len(r.Module) > 128 || len(r.CorrelationID) > 128 || len(uploads) > 4 {
		return Report{}, ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.recoverAttachments(ctx); err != nil {
		return Report{}, err
	}
	var existing string
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM reports WHERE sid=? AND request_id=?`, r.SID, r.RequestID).Scan(&existing)
	if err == nil {
		var previous Report
		if err = json.Unmarshal([]byte(existing), &previous); err != nil {
			return Report{}, err
		}
		if previous.Description != r.Description || previous.Steps != r.Steps || previous.Module != r.Module || len(previous.Attachments) != len(uploads) {
			return Report{}, ErrInvalid
		}
		for i, a := range previous.Attachments {
			u := uploads[i]
			if a.Name != filepath.Base(u.Name) || a.Type != u.Type {
				return Report{}, ErrInvalid
			}
			content, e := os.ReadFile(filepath.Join(s.root, previous.ID, a.ID))
			if e != nil {
				return Report{}, e
			}
			if !bytes.Equal(content, u.Data) {
				return Report{}, ErrInvalid
			}
		}
		return previous, nil
	}
	if err != sql.ErrNoRows {
		return Report{}, err
	}
	var total, personal, recent int64
	if err = s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(bytes),0),COALESCE(SUM(CASE WHEN sid=? THEN bytes ELSE 0 END),0),COALESCE(SUM(CASE WHEN sid=? AND saved_at>? THEN 1 ELSE 0 END),0) FROM reports`, r.SID, r.SID, time.Now().Add(-10*time.Minute).Unix()).Scan(&total, &personal, &recent); err != nil {
		return Report{}, err
	}
	size := int64(len(r.Description) + len(r.Steps))
	images, diagnostics := 0, 0
	for _, u := range uploads {
		if len(u.Data) > 4*1024*1024 || len(u.Name) > 256 {
			return Report{}, ErrInvalid
		}
		switch u.Type {
		case "image/png", "image/jpeg", "image/webp":
			images++
		case "application/json", "text/plain":
			diagnostics++
		default:
			return Report{}, ErrInvalid
		}
		size += int64(len(u.Data))
	}
	if images > 3 || diagnostics > 1 {
		return Report{}, ErrInvalid
	}
	if total+size > s.limits.TotalBytes || personal+size > s.limits.PersonalBytes || recent >= s.limits.SubmissionsPerTenMinutes {
		return Report{}, ErrCapacity
	}
	r.ID, err = auth.RandomToken(18)
	if err != nil {
		return Report{}, err
	}
	r.Status = "new"
	r.SavedAt = time.Now().UTC()
	r.Attachments = []Attachment{}
	directory := filepath.Join(s.root, r.ID)
	if _, err = s.db.ExecContext(ctx, `INSERT INTO attachment_journal(id) VALUES(?)`, r.ID); err != nil {
		return Report{}, err
	}
	if err = os.Mkdir(directory, 0700); err != nil {
		return Report{}, err
	}
	saved := false
	defer func() {
		if !saved {
			_ = s.removeAttachments(r.ID)
		}
	}()
	for _, u := range uploads {
		id, e := auth.RandomToken(18)
		if e != nil {
			return Report{}, e
		}
		if e = writeAttachment(filepath.Join(directory, id), u.Data); e != nil {
			return Report{}, e
		}
		r.Attachments = append(r.Attachments, Attachment{id, filepath.Base(u.Name), u.Type, int64(len(u.Data))})
	}
	payload, _ := json.Marshal(r)
	_, err = s.db.ExecContext(ctx, `INSERT INTO reports(id,sid,request_id,saved_at,bytes,payload) VALUES(?,?,?,?,?,?)`, r.ID, r.SID, r.RequestID, r.SavedAt.Unix(), size, string(payload))
	if err != nil {
		return Report{}, err
	}
	saved = true
	_, _ = s.db.ExecContext(context.WithoutCancel(ctx), `DELETE FROM attachment_journal WHERE id=?`, r.ID)
	return r, nil
}
func (s *Store) List(ctx context.Context, sid string, admin bool) ([]Report, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT payload FROM reports WHERE (? OR sid=?) ORDER BY saved_at DESC,id DESC LIMIT 200`, admin, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Report{}
	for rows.Next() {
		var raw string
		var r Report
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}
func (s *Store) Get(ctx context.Context, id, sid string, admin bool) (Report, error) {
	var r Report
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM reports WHERE id=? AND (? OR sid=?)`, id, admin, sid).Scan(&raw)
	if err == sql.ErrNoRows {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	err = json.Unmarshal([]byte(raw), &r)
	return r, err
}
func (s *Store) SetStatus(ctx context.Context, id, status string) (Report, error) {
	if status != "new" && status != "in_progress" && status != "resolved" {
		return Report{}, ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.Get(ctx, id, "", true)
	if err != nil {
		return r, err
	}
	r.Status = status
	raw, _ := json.Marshal(r)
	_, err = s.db.ExecContext(ctx, `UPDATE reports SET payload=? WHERE id=?`, string(raw), id)
	return r, err
}
func (s *Store) Attachment(ctx context.Context, id, attachment, sid string, admin bool) (*os.File, Attachment, error) {
	r, err := s.Get(ctx, id, sid, admin)
	if err != nil {
		return nil, Attachment{}, err
	}
	for _, a := range r.Attachments {
		if a.ID == attachment {
			file, err := os.Open(filepath.Join(s.root, r.ID, a.ID))
			return file, a, err
		}
	}
	return nil, Attachment{}, ErrNotFound
}
func (s *Store) Prune(ctx context.Context, before time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM reports WHERE saved_at<?`, before.Unix())
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		tx, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO attachment_journal(id) VALUES(?)`, id); err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM reports WHERE id=?`, id)
		}
		if err != nil {
			tx.Rollback()
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		if err = s.removeAttachments(id); err != nil {
			return fmt.Errorf("remove feedback attachments: %w", err)
		}
		if _, err = s.db.ExecContext(ctx, `DELETE FROM attachment_journal WHERE id=?`, id); err != nil {
			return err
		}
	}
	return nil
}
