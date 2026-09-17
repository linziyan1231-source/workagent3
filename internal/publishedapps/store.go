// Package publishedapps owns published application identity, access and versions.
package publishedapps

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"math/big"
	_ "modernc.org/sqlite"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
	"workagent3/internal/auth"
)

var ErrNotFound = errors.New("application_not_found")
var ErrInvalid = errors.New("invalid_application")
var ErrPorts = errors.New("application_ports_exhausted")

// ErrEmployeePorts rejects a publish when the owner already holds the
// configured maximum number of public application ports.
var ErrEmployeePorts = errors.New("application_employee_ports_exceeded")

// DefaultMaxEmployeePorts caps how many public application ports one employee
// may hold at once. The admin console can override it at runtime.
const DefaultMaxEmployeePorts = 3

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
	ShareToken     string    `json:"shareToken,omitempty"`
	Password       string    `json:"password,omitempty"`
	ExpiresAt      time.Time `json:"expiresAt,omitempty"`
	Revision       int64     `json:"revision"`
	CreatedAt      time.Time `json:"createdAt"`
}

// Access modes: owner and members require specific WorkAgent accounts,
// authenticated any logged-in account, token a share link carrying the share
// token, password an 8-digit access code, public anyone.
const (
	AccessOwner         = "owner"
	AccessMembers       = "members"
	AccessAuthenticated = "authenticated"
	AccessToken         = "token"
	AccessPassword      = "password"
	AccessPublic        = "public"
)

// DefaultValidity is applied when a publish request does not state one.
const DefaultValidity = 5 * 24 * time.Hour

type Store struct {
	db             *sql.DB
	mu             sync.Mutex
	first, last    int
	maxPerEmployee int
}

// Open loads the store. The first/last/maxPerEmployee arguments are only
// initial defaults: once the admin console saves settings they are persisted
// in the settings table and win over the flags on later starts. On the first
// start without saved settings the flag range is persisted and existing apps
// are remapped into it.
func Open(file string, first, last, maxPerEmployee int) (*Store, error) {
	if first < 1024 || last > 65535 || last-first < 1 {
		return nil, ErrInvalid
	}
	if maxPerEmployee < 1 {
		maxPerEmployee = DefaultMaxEmployeePorts
	}
	db, err := sql.Open("sqlite", file)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,owner_sid TEXT NOT NULL,payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS app_ports(port INTEGER PRIMARY KEY,app_id TEXT NOT NULL,preview INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db, first: first, last: last, maxPerEmployee: maxPerEmployee}
	saved, err := s.loadSettings()
	if err != nil {
		db.Close()
		return nil, err
	}
	if !saved {
		if _, err = s.SetRange(context.Background(), first, last); err != nil {
			db.Close()
			return nil, err
		}
		if err = s.SetMaxEmployeePorts(context.Background(), maxPerEmployee); err != nil {
			db.Close()
			return nil, err
		}
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }

// loadSettings applies persisted admin settings. It reports whether a port
// range was already saved (saved settings override the flag defaults).
func (s *Store) loadSettings() (bool, error) {
	rows, err := s.db.Query(`SELECT key,value FROM settings`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	values := map[string]string{}
	for rows.Next() {
		var key, value string
		if err = rows.Scan(&key, &value); err != nil {
			return false, err
		}
		values[key] = value
	}
	if err = rows.Err(); err != nil {
		return false, err
	}
	first, firstOK := values["port_first"]
	last, lastOK := values["port_last"]
	saved := false
	if firstOK && lastOK {
		f, ferr := strconv.Atoi(first)
		l, lerr := strconv.Atoi(last)
		if ferr != nil || lerr != nil || f < 1024 || l > 65535 || l-f < 1 {
			return false, ErrInvalid
		}
		s.first, s.last = f, l
		saved = true
	}
	if raw, ok := values["max_employee_ports"]; ok {
		n, nerr := strconv.Atoi(raw)
		if nerr != nil || n < 1 {
			return false, ErrInvalid
		}
		s.maxPerEmployee = n
	}
	return saved, nil
}

// Settings returns the active port range and per-employee public-port quota.
func (s *Store) Settings() (first, last, maxPerEmployee int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.first, s.last, s.maxPerEmployee
}

// SetRange moves the allocatable port range. Existing applications are
// remapped into the new range in creation order (two consecutive ports per
// app); it fails with ErrPorts when they do not fit. It returns the IDs of
// apps whose ports changed so the gateway can rebind their listeners.
func (s *Store) SetRange(ctx context.Context, first, last int) ([]string, error) {
	if first < 1024 || last > 65535 || last-first < 1 {
		return nil, ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,payload FROM apps WHERE deleted=0 ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	apps := []App{}
	for rows.Next() {
		var a App
		var raw string
		if err = rows.Scan(&a.ID, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &a); err != nil {
			rows.Close()
			return nil, err
		}
		apps = append(apps, a)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if 2*len(apps) > last-first+1 {
		return nil, ErrPorts
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM app_ports`); err != nil {
		return nil, err
	}
	changed := []string{}
	port := first
	for _, a := range apps {
		if a.Port != port || a.PreviewPort != port+1 {
			changed = append(changed, a.ID)
		}
		a.Port = port
		a.PreviewPort = port + 1
		raw, _ := json.Marshal(a)
		if _, err = tx.ExecContext(ctx, `UPDATE apps SET payload=? WHERE id=?`, string(raw), a.ID); err != nil {
			return nil, err
		}
		for _, p := range []struct {
			port    int
			preview bool
		}{{a.Port, false}, {a.PreviewPort, true}} {
			if _, err = tx.ExecContext(ctx, `INSERT INTO app_ports(port,app_id,preview) VALUES(?,?,?)`, p.port, a.ID, p.preview); err != nil {
				return nil, err
			}
		}
		port += 2
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO settings(key,value) VALUES('port_first',?),('port_last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, strconv.Itoa(first), strconv.Itoa(last)); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	s.first, s.last = first, last
	return changed, nil
}

// SetMaxEmployeePorts updates the per-employee public-port quota.
func (s *Store) SetMaxEmployeePorts(ctx context.Context, n int) error {
	if n < 1 {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO settings(key,value) VALUES('max_employee_ports',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, strconv.Itoa(n)); err != nil {
		return err
	}
	s.maxPerEmployee = n
	return nil
}

// PortUsage reports how many ports are reserved in total and how many public
// (non-preview) ports each owner holds.
func (s *Store) PortUsage(ctx context.Context) (used int, byOwner map[string]int, err error) {
	byOwner = map[string]int{}
	if err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM app_ports`).Scan(&used); err != nil {
		return 0, nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT a.owner_sid,COUNT(*) FROM app_ports p JOIN apps a ON a.id=p.app_id WHERE p.preview=0 AND a.deleted=0 GROUP BY a.owner_sid`)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sid string
		var count int
		if err = rows.Scan(&sid, &count); err != nil {
			return 0, nil, err
		}
		byOwner[sid] = count
	}
	return used, byOwner, rows.Err()
}
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
	var held int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM app_ports p JOIN apps existing ON existing.id=p.app_id WHERE p.preview=0 AND existing.deleted=0 AND existing.owner_sid=?`, a.OwnerSID).Scan(&held); err != nil {
		return App{}, err
	}
	if held >= s.maxPerEmployee {
		return App{}, ErrEmployeePorts
	}
	used := map[int]bool{}
	portRows, err := tx.QueryContext(ctx, `SELECT port FROM app_ports`)
	if err != nil {
		return App{}, err
	}
	for portRows.Next() {
		var p int
		if err = portRows.Scan(&p); err != nil {
			portRows.Close()
			return App{}, err
		}
		used[p] = true
	}
	if err = portRows.Err(); err != nil {
		portRows.Close()
		return App{}, err
	}
	portRows.Close()
	// Allocate the lowest free consecutive pair so reclaimed ports are reused;
	// the range is deliberately small and admin-configured.
	port := -1
	for p := s.first; p+1 <= s.last; p++ {
		if !used[p] && !used[p+1] {
			port = p
			break
		}
	}
	if port < 0 {
		return App{}, ErrPorts
	}
	a.ID, err = auth.RandomToken(18)
	if err != nil {
		return App{}, err
	}
	a.Port = port
	a.PreviewPort = port + 1
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
	if !ValidAccess(a.Access) {
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
func ValidAccess(access string) bool {
	switch access {
	case AccessOwner, AccessMembers, AccessAuthenticated, AccessToken, AccessPassword, AccessPublic:
		return true
	}
	return false
}

// Expired reports whether the app's validity window has passed. A zero
// ExpiresAt means the app does not expire.
func (a App) Expired(now time.Time) bool {
	return !a.ExpiresAt.IsZero() && !now.Before(a.ExpiresAt)
}

func (s *Store) Delete(ctx context.Context, id, ownerSID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE apps SET deleted=1 WHERE id=? AND owner_sid=? AND deleted=0`, id, ownerSID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	// Reclaim the reserved ports so the small configured range stays usable.
	if _, err = tx.ExecContext(ctx, `DELETE FROM app_ports WHERE app_id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// RandomAccessCode returns an 8-digit numeric access code for
// password-protected apps.
func RandomAccessCode() (string, error) {
	var digits [8]byte
	for i := range digits {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		digits[i] = byte('0' + n.Int64())
	}
	return string(digits[:]), nil
}

func (a App) Allows(userID int64, preview bool) bool {
	if preview {
		return userID != 0 && userID == a.OwnerID
	}
	if !a.Enabled || a.Expired(time.Now()) {
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
