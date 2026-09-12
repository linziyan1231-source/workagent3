package chatforward

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const DefaultWeeklyLimit = 7
const PolicyVersion = "dispatched-v1"

var ErrConflict = errors.New("chatforward idempotency conflict")
var ErrNotFound = errors.New("chatforward request not found")
var ErrInvalid = errors.New("chatforward invalid request")
var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type Store struct{ db *sql.DB }

type Usage struct {
	Limit     int       `json:"limit"`
	Used      int       `json:"used"`
	Pending   int       `json:"pending"`
	Unknown   int       `json:"unknown"`
	Remaining int       `json:"remaining"`
	WeekStart time.Time `json:"week_start"`
	ResetAt   time.Time `json:"reset_at"`
	Policy    string    `json:"policy"`
}

type Send struct {
	LogicalID      string    `json:"logical_id"`
	AttemptID      string    `json:"attempt_id"`
	Model          string    `json:"requested_model"`
	State          string    `json:"state"`
	Outcome        string    `json:"outcome"`
	UpstreamStatus int       `json:"upstream_status"`
	ReservedAt     time.Time `json:"reserved_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	Resolved       bool      `json:"resolved"`
}

type Reservation struct {
	Allowed   bool   `json:"allowed"`
	Pro       bool   `json:"pro"`
	Code      string `json:"code,omitempty"`
	LogicalID string `json:"logical_id"`
	AttemptID string `json:"attempt_id"`
	Model     string `json:"requested_model"`
	Usage     Usage  `json:"quota"`
}

type Event struct {
	EventID        string `json:"event_id"`
	LogicalID      string `json:"logical_id"`
	AttemptID      string `json:"attempt_id"`
	Kind           string `json:"kind"`
	Outcome        string `json:"outcome,omitempty"`
	UpstreamStatus int    `json:"upstream_status,omitempty"`
	Dispatched     bool   `json:"dispatched,omitempty"`
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	_, err = db.Exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS subjects(id INTEGER PRIMARY KEY AUTOINCREMENT,sid TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS limits(sid TEXT PRIMARY KEY,weekly_limit INTEGER NOT NULL CHECK(weekly_limit BETWEEN 0 AND 10000));
CREATE TABLE IF NOT EXISTS sends(subject INTEGER NOT NULL REFERENCES subjects(id),logical_id TEXT NOT NULL,attempt_id TEXT NOT NULL,model TEXT NOT NULL,week_start INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','unknown','dispatched','cancelled')),outcome TEXT NOT NULL DEFAULT 'pending',upstream_status INTEGER NOT NULL DEFAULT 0,reserved_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(subject,logical_id),UNIQUE(subject,attempt_id));
CREATE INDEX IF NOT EXISTS sends_week ON sends(subject,week_start,state);
CREATE TABLE IF NOT EXISTS events(subject INTEGER NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(subject,event_id));
CREATE TABLE IF NOT EXISTS resolutions(id INTEGER PRIMARY KEY AUTOINCREMENT,subject INTEGER NOT NULL,logical_id TEXT NOT NULL,actor TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);
`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize ChatGPT Pro ledger: %w", err)
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }

// Subject is independent of Portal row IDs, which SQLite can reuse after deletion.
func (s *Store) Subject(ctx context.Context, sid string) (int64, error) {
	if !strings.HasPrefix(sid, "S-1-") {
		return 0, errors.New("invalid employee SID")
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO subjects(sid) VALUES(?)`, sid); err != nil {
		return 0, err
	}
	var id int64
	err := s.db.QueryRowContext(ctx, `SELECT id FROM subjects WHERE sid=?`, sid).Scan(&id)
	return id, err
}
func (s *Store) SubjectSID(ctx context.Context, id int64) (string, error) {
	var sid string
	err := s.db.QueryRowContext(ctx, `SELECT sid FROM subjects WHERE id=?`, id).Scan(&sid)
	return sid, err
}

func week(now time.Time) (time.Time, time.Time) {
	local := now.In(time.FixedZone("Asia/Shanghai", 8*3600))
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	start := day.AddDate(0, 0, -(int(day.Weekday())+6)%7)
	return start, start.AddDate(0, 0, 7)
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func usage(ctx context.Context, q queryer, sid string, now time.Time) (Usage, error) {
	start, end := week(now)
	u := Usage{Limit: DefaultWeeklyLimit, WeekStart: start, ResetAt: end, Policy: PolicyVersion}
	err := q.QueryRowContext(ctx, `SELECT weekly_limit FROM limits WHERE sid=?`, sid).Scan(&u.Limit)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return u, err
	}
	err = q.QueryRowContext(ctx, `SELECT COALESCE(SUM(state='dispatched'),0),COALESCE(SUM(state IN ('reserved','unknown')),0),COALESCE(SUM(state='unknown'),0) FROM sends WHERE subject=(SELECT id FROM subjects WHERE sid=?) AND week_start=?`, sid, start.Unix()).Scan(&u.Used, &u.Pending, &u.Unknown)
	u.Remaining = max(0, u.Limit-u.Used-u.Pending)
	return u, err
}
func (s *Store) Usage(ctx context.Context, sid string, now time.Time) (Usage, error) {
	return usage(ctx, s.db, sid, now)
}
func (s *Store) SetLimit(ctx context.Context, sid string, limit int) error {
	if !strings.HasPrefix(sid, "S-1-") || limit < 0 || limit > 10000 {
		return errors.New("invalid weekly limit")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO limits(sid,weekly_limit) VALUES(?,?) ON CONFLICT(sid) DO UPDATE SET weekly_limit=excluded.weekly_limit`, sid, limit)
	return err
}

func (s *Store) Reserve(ctx context.Context, subject int64, logical, attempt, model string, now time.Time) (Reservation, error) {
	r := Reservation{Pro: true, LogicalID: logical, AttemptID: attempt, Model: model}
	if !validID.MatchString(logical) || !validID.MatchString(attempt) || len(model) > 128 || model == "" {
		return r, errors.New("invalid send")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return r, err
	}
	defer tx.Rollback()
	var sid string
	if err = tx.QueryRowContext(ctx, `SELECT sid FROM subjects WHERE id=?`, subject).Scan(&sid); err != nil {
		return r, ErrNotFound
	}
	var oldAttempt, oldModel, state string
	err = tx.QueryRowContext(ctx, `SELECT attempt_id,model,state FROM sends WHERE subject=? AND logical_id=?`, subject, logical).Scan(&oldAttempt, &oldModel, &state)
	if err == nil {
		if oldAttempt != attempt || (oldModel != "" && oldModel != model) {
			return r, ErrConflict
		}
		// A retry of reservation delivery may recover an unspent permission. The
		// source persists dispatch intent before using it, never after recovery.
		r.Allowed = state == "reserved"
		r.Code = "chatgpt_pro_send_already_processed"
		if state == "unknown" {
			r.Code = "chatgpt_pro_send_pending"
		}
		if r.Allowed {
			r.Code = ""
		}
		r.Usage, err = usage(ctx, tx, sid, now)
		return r, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return r, err
	}
	r.Usage, err = usage(ctx, tx, sid, now)
	if err != nil {
		return r, err
	}
	if r.Usage.Remaining == 0 {
		r.Code = "chatgpt_pro_quota_exceeded"
		return r, nil
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO sends(subject,logical_id,attempt_id,model,week_start,state,reserved_at,updated_at) VALUES(?,?,?,?,?,'reserved',?,?)`, subject, logical, attempt, model, r.Usage.WeekStart.Unix(), now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return r, ErrConflict
	}
	if err = tx.Commit(); err != nil {
		return r, err
	}
	r.Allowed = true
	r.Usage.Pending++
	r.Usage.Remaining--
	return r, nil
}

func (s *Store) ApplyEvent(ctx context.Context, subject int64, e Event, now time.Time) error {
	if !validID.MatchString(e.EventID) || !validID.MatchString(e.LogicalID) || !validID.MatchString(e.AttemptID) || e.UpstreamStatus < 0 || e.UpstreamStatus > 599 {
		return ErrInvalid
	}
	if e.Kind != "dispatch" && e.Kind != "unknown" && e.Kind != "cancel" && e.Kind != "settle" {
		return ErrInvalid
	}
	if e.Outcome != "" && e.Outcome != "completed" && e.Outcome != "failed" && e.Outcome != "interrupted" && e.Outcome != "unknown" {
		return ErrInvalid
	}
	payload, _ := json.Marshal(e)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var previous string
	err = tx.QueryRowContext(ctx, `SELECT payload FROM events WHERE subject=? AND event_id=?`, subject, e.EventID).Scan(&previous)
	if err == nil {
		if previous != string(payload) {
			return ErrConflict
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var attempt, state, outcome string
	var status, resolved int
	err = tx.QueryRowContext(ctx, `SELECT attempt_id,state,outcome,upstream_status,resolved FROM sends WHERE subject=? AND logical_id=?`, subject, e.LogicalID).Scan(&attempt, &state, &outcome, &status, &resolved)
	if errors.Is(err, sql.ErrNoRows) {
		// A cancellation can overtake a delayed reservation. Keep a tombstone so
		// the late reserve cannot authorize a send the source already blocked.
		if e.Kind != "cancel" {
			return ErrNotFound
		}
		start, _ := week(now)
		_, err = tx.ExecContext(ctx, `INSERT INTO sends(subject,logical_id,attempt_id,model,week_start,state,reserved_at,updated_at) VALUES(?,?,?,'',?,'cancelled',?,?)`, subject, e.LogicalID, e.AttemptID, start.Unix(), now.UnixMilli(), now.UnixMilli())
		if err != nil {
			return err
		}
		state = "cancelled"
		attempt = e.AttemptID
	} else if err != nil {
		return err
	}
	if attempt != e.AttemptID {
		return ErrConflict
	}
	dispatched := e.Kind == "dispatch" || e.Dispatched || e.UpstreamStatus > 0
	if resolved != 0 || state == "cancelled" {
		if dispatched && state != "dispatched" {
			return ErrConflict
		}
	} else {
		if dispatched {
			state = "dispatched"
		} else if e.Kind == "cancel" && state != "dispatched" {
			state = "cancelled"
		} else if (e.Kind == "unknown" || e.Kind == "settle") && state == "reserved" {
			state = "unknown"
		}
	}
	if e.Kind == "settle" && (outcome == "pending" || outcome == "unknown" || e.Outcome == "completed") {
		if e.Outcome != "" {
			outcome = e.Outcome
		}
		if e.UpstreamStatus > 0 {
			status = e.UpstreamStatus
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE sends SET state=?,outcome=?,upstream_status=?,updated_at=? WHERE subject=? AND logical_id=?`, state, outcome, status, now.UnixMilli(), subject, e.LogicalID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO events(subject,event_id,payload) VALUES(?,?,?)`, subject, e.EventID, string(payload))
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Sends(ctx context.Context, sid string, now time.Time) ([]Send, error) {
	start, _ := week(now)
	rows, err := s.db.QueryContext(ctx, `SELECT logical_id,attempt_id,model,state,outcome,upstream_status,reserved_at,updated_at,resolved FROM sends WHERE subject=(SELECT id FROM subjects WHERE sid=?) AND (week_start=? OR state IN ('reserved','unknown')) ORDER BY reserved_at DESC LIMIT 200`, sid, start.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Send{}
	for rows.Next() {
		var v Send
		var a, b int64
		var resolved int
		if err = rows.Scan(&v.LogicalID, &v.AttemptID, &v.Model, &v.State, &v.Outcome, &v.UpstreamStatus, &a, &b, &resolved); err != nil {
			return nil, err
		}
		v.ReservedAt = time.UnixMilli(a)
		v.UpdatedAt = time.UnixMilli(b)
		v.Resolved = resolved != 0
		result = append(result, v)
	}
	return result, rows.Err()
}

// Resolve only reviews uncertain dispatch. Already-dispatched requests cannot
// be refunded because a response failed or used a different model.
func (s *Store) Resolve(ctx context.Context, sid, logical, decision, actor, reason string, now time.Time) error {
	if !validID.MatchString(logical) || (decision != "dispatched" && decision != "cancelled") || strings.TrimSpace(reason) == "" || len(reason) > 500 || actor == "" {
		return errors.New("invalid resolution")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var subject int64
	var state string
	var reservedAt int64
	err = tx.QueryRowContext(ctx, `SELECT s.subject,s.state,s.reserved_at FROM sends s JOIN subjects p ON p.id=s.subject WHERE p.sid=? AND s.logical_id=?`, sid, logical).Scan(&subject, &state, &reservedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if state != "unknown" && state != "reserved" {
		return ErrConflict
	}
	if state == "reserved" && now.Sub(time.UnixMilli(reservedAt)) < 15*time.Minute {
		return ErrConflict
	}
	_, err = tx.ExecContext(ctx, `UPDATE sends SET state=?,resolved=1,updated_at=? WHERE subject=? AND logical_id=?`, decision, now.UnixMilli(), subject, logical)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO resolutions(subject,logical_id,actor,decision,reason,at) VALUES(?,?,?,?,?,?)`, subject, logical, actor, decision, reason, now.UnixMilli())
	if err != nil {
		return err
	}
	return tx.Commit()
}
