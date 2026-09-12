// Package publishedapps owns published application identity, access and versions.
package publishedapps

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	_ "modernc.org/sqlite"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"
	"workagent3/internal/auth"
)

var ErrNotFound = errors.New("application_not_found")
var ErrInvalid = errors.New("invalid_application")
var ErrPorts = errors.New("application_ports_exhausted")

type App struct {
	ID             string    `json:"id"`
	OwnerSID       string    `json:"-"`
	OwnerID        int64     `json:"ownerId"`
	WorkspaceID    string    `json:"workspaceId"`
	Name           string    `json:"name"`
	Kind           string    `json:"kind"`
	Entry          string    `json:"entry"`
	AllowedOrigins []string  `json:"allowedOrigins"`
	Access         string    `json:"access"`
	Members        []int64   `json:"members"`
	Version        string    `json:"version"`
	PreviewVersion string    `json:"previewVersion"`
	Versions       []string  `json:"versions"`
	Port           int       `json:"port"`
	PreviewPort    int       `json:"previewPort"`
	Enabled        bool      `json:"enabled"`
	Revision       int64     `json:"revision"`
	CreatedAt      time.Time `json:"createdAt"`
}
type Store struct {
	db          *sql.DB
	mu          sync.Mutex
	first, last int
}

func Open(file string, first, last int) (*Store, error) {
	if first < 1024 || last > 65535 || last-first < 1 {
		return nil, ErrInvalid
	}
	db, err := sql.Open("sqlite", file)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,owner_sid TEXT NOT NULL,payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS app_ports(port INTEGER PRIMARY KEY,app_id TEXT NOT NULL,preview INTEGER NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db, first: first, last: last}, nil
}
func (s *Store) Close() error { return s.db.Close() }
func Validate(a App) error {
	if a.Name == "" || len(a.Name) > 120 || a.WorkspaceID == "" || len(a.WorkspaceID) > 160 {
		return ErrInvalid
	}
	if a.Kind != "static" && a.Kind != "node" && a.Kind != "python" {
		return ErrInvalid
	}
	if a.Entry == "" || strings.ContainsAny(a.Entry, "\\:\x00") || strings.HasPrefix(a.Entry, "/") || path.Clean(a.Entry) != a.Entry || a.Entry == ".." || strings.HasPrefix(a.Entry, "../") {
		return ErrInvalid
	}
	if len(a.AllowedOrigins) > 32 {
		return ErrInvalid
	}
	for _, raw := range a.AllowedOrigins {
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return ErrInvalid
		}
	}
	return nil
}
func (s *Store) Create(ctx context.Context, a App) (App, error) {
	if err := Validate(a); err != nil {
		return App{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return App{}, err
	}
	defer tx.Rollback()
	var highest int
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(port),?) FROM app_ports`, s.first-1).Scan(&highest); err != nil {
		return App{}, err
	}
	if highest+2 > s.last {
		return App{}, ErrPorts
	}
	a.ID, err = auth.RandomToken(18)
	if err != nil {
		return App{}, err
	}
	a.Port = highest + 1
	a.PreviewPort = highest + 2
	a.Access = "owner"
	a.Members = []int64{}
	a.Versions = []string{}
	a.Version = ""
	a.PreviewVersion = ""
	a.Enabled = false
	a.Revision = 1
	a.CreatedAt = time.Now().UTC()
	raw, _ := json.Marshal(a)
	if _, err = tx.ExecContext(ctx, `INSERT INTO apps(id,owner_sid,payload) VALUES(?,?,?)`, a.ID, a.OwnerSID, string(raw)); err != nil {
		return App{}, err
	}
	for _, p := range []struct {
		port    int
		preview bool
	}{{a.Port, false}, {a.PreviewPort, true}} {
		if _, err = tx.ExecContext(ctx, `INSERT INTO app_ports(port,app_id,preview) VALUES(?,?,?)`, p.port, a.ID, p.preview); err != nil {
			return App{}, err
		}
	}
	return a, tx.Commit()
}
func (s *Store) Get(ctx context.Context, id string) (App, error) {
	var a App
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT owner_sid,payload FROM apps WHERE id=? AND deleted=0`, id).Scan(&a.OwnerSID, &raw)
	if err == sql.ErrNoRows {
		return a, ErrNotFound
	}
	if err != nil {
		return a, err
	}
	err = json.Unmarshal([]byte(raw), &a)
	return a, err
}
func (s *Store) List(ctx context.Context, sid string) ([]App, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT owner_sid,payload FROM apps WHERE deleted=0 AND (?='' OR owner_sid=?) ORDER BY id`, sid, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []App{}
	for rows.Next() {
		var a App
		var raw string
		if err = rows.Scan(&a.OwnerSID, &raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &a); err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}
func (s *Store) Update(ctx context.Context, a App, expected int64) (App, error) {
	if a.Access != "owner" && a.Access != "members" && a.Access != "authenticated" && a.Access != "public" {
		return App{}, ErrInvalid
	}
	if len(a.Members) > 1000 {
		return App{}, ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.Get(ctx, a.ID)
	if err != nil {
		return App{}, err
	}
	if current.Revision != expected || current.OwnerSID != a.OwnerSID {
		return App{}, errors.New("application_version_conflict")
	}
	a.Revision = expected + 1
	raw, _ := json.Marshal(a)
	_, err = s.db.ExecContext(ctx, `UPDATE apps SET payload=? WHERE id=?`, string(raw), a.ID)
	return a, err
}
func (a App) Allows(userID int64, preview bool) bool {
	if preview {
		return userID != 0 && userID == a.OwnerID
	}
	if !a.Enabled {
		return false
	}
	if a.Access == "public" {
		return true
	}
	if userID == 0 {
		return false
	}
	if userID == a.OwnerID || a.Access == "authenticated" {
		return true
	}
	if a.Access == "members" {
		for _, id := range a.Members {
			if id == userID {
				return true
			}
		}
	}
	return false
}
