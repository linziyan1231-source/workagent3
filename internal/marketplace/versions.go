package marketplace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (s *Store) migrateVersions() error {
	var selectionsExist int
	if err := s.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='marketplace_selections'`).Scan(&selectionsExist); err != nil {
		return err
	}
	rows, err := s.db.Query(`PRAGMA table_info(marketplace_entries)`)
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, kind string
		var def any
		if err = rows.Scan(&cid, &name, &kind, &notnull, &def, &pk); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	rows.Close()
	for _, c := range []struct{ name, definition string }{{"series_id", "TEXT NOT NULL DEFAULT ''"}, {"release_notes", "TEXT NOT NULL DEFAULT ''"}, {"revoked", "INTEGER NOT NULL DEFAULT 0"}, {"default_enabled", "INTEGER NOT NULL DEFAULT 1"}} {
		if !columns[c.name] {
			if _, err = s.db.Exec(`ALTER TABLE marketplace_entries ADD COLUMN ` + c.name + ` ` + c.definition); err != nil {
				return err
			}
		}
	}
	_, err = s.db.Exec(`UPDATE marketplace_entries SET series_id=(SELECT first.id FROM marketplace_entries first WHERE first.publisher=marketplace_entries.publisher AND first.kind=marketplace_entries.kind AND first.name=marketplace_entries.name ORDER BY first.created_at,first.id LIMIT 1) WHERE series_id='';
 CREATE UNIQUE INDEX IF NOT EXISTS market_series_version ON marketplace_entries(series_id,version);
 CREATE TABLE IF NOT EXISTS marketplace_selections(sid TEXT NOT NULL,series_id TEXT NOT NULL,entry_id TEXT NOT NULL,PRIMARY KEY(sid,series_id));
 CREATE TABLE IF NOT EXISTS marketplace_subscriptions(project_id TEXT NOT NULL,series_id TEXT NOT NULL,entry_id TEXT NOT NULL,PRIMARY KEY(project_id,series_id));
 CREATE TABLE IF NOT EXISTS marketplace_actions(id TEXT PRIMARY KEY,series_id TEXT NOT NULL,target_id TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS marketplace_action_targets(action_id TEXT NOT NULL,sid TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT NOT NULL DEFAULT '',PRIMARY KEY(action_id,sid));`)
	if err != nil {
		return err
	}
	if selectionsExist == 0 {
		rows, err := s.db.Query(`SELECT i.sid,e.series_id,e.id,e.version,i.state FROM marketplace_installations i JOIN marketplace_entries e ON e.id=i.entry_id`)
		if err != nil {
			return err
		}
		type adopted struct{ sid, series, id, version string }
		chosen := map[string]adopted{}
		for rows.Next() {
			var a adopted
			var raw string
			if err = rows.Scan(&a.sid, &a.series, &a.id, &a.version, &raw); err != nil {
				rows.Close()
				return err
			}
			var state Installation
			if err = json.Unmarshal([]byte(raw), &state); err != nil {
				rows.Close()
				return err
			}
			key := a.sid + ":" + a.series
			if old, ok := chosen[key]; state.Complete && (!ok || Newer(a.version, old.version)) {
				chosen[key] = a
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, a := range chosen {
			if err = s.Select(context.Background(), a.sid, Entry{ID: a.id, SeriesID: a.series}); err != nil {
				return err
			}
		}
	}
	return nil
}

// Versions are immutable snapshots. A selection changes only after an explicit install/update.
func Newer(a, b string) bool {
	aa, bb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		var x, y uint64
		if i < len(aa) {
			x, _ = strconv.ParseUint(aa[i], 10, 64)
		}
		if i < len(bb) {
			y, _ = strconv.ParseUint(bb[i], 10, 64)
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func (s *Store) Versions(ctx context.Context, series string, admin bool) ([]Entry, error) {
	query := `SELECT id,kind,name,description,version,publisher,created_at,series_id,release_notes,revoked,listed,default_enabled FROM marketplace_entries WHERE (?='' OR series_id=?)`
	if !admin {
		query += ` AND listed=1 AND revoked=0`
	}
	rows, err := s.db.QueryContext(ctx, query, series, series)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		var e Entry
		var stamp string
		if err = rows.Scan(&e.ID, &e.Kind, &e.Name, &e.Description, &e.Version, &e.Publisher, &stamp, &e.SeriesID, &e.ReleaseNotes, &e.Revoked, &e.Listed, &e.DefaultEnabled); err != nil {
			return nil, err
		}
		e.CreatedAt, _ = time.Parse(time.RFC3339Nano, stamp)
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return Newer(out[i].Version, out[j].Version) })
	return out, rows.Err()
}

// Snapshot is for installed-version recovery and administrator removal, never public discovery.
func (s *Store) Snapshot(ctx context.Context, id string) (Entry, Bundle, error) {
	var e Entry
	var b Bundle
	var raw []byte
	var stamp string
	err := s.db.QueryRowContext(ctx, `SELECT id,kind,name,description,version,publisher,created_at,series_id,release_notes,revoked,listed,default_enabled,bundle FROM marketplace_entries WHERE id=?`, id).Scan(&e.ID, &e.Kind, &e.Name, &e.Description, &e.Version, &e.Publisher, &stamp, &e.SeriesID, &e.ReleaseNotes, &e.Revoked, &e.Listed, &e.DefaultEnabled, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return e, b, ErrNotFound
	}
	if err != nil {
		return e, b, err
	}
	e.CreatedAt, _ = time.Parse(time.RFC3339Nano, stamp)
	err = json.Unmarshal(raw, &b)
	return e, b, err
}

func (s *Store) Selection(ctx context.Context, sid, series string) (Entry, Installation, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT entry_id FROM marketplace_selections WHERE sid=? AND series_id=?`, sid, series).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Entry{}, Installation{}, ErrNotFound
	}
	if err != nil {
		return Entry{}, Installation{}, err
	}
	versions, err := s.Versions(ctx, series, true)
	if err != nil {
		return Entry{}, Installation{}, err
	}
	for _, v := range versions {
		if v.ID == id {
			i, e := s.Installation(ctx, sid, id)
			return v, i, e
		}
	}
	return Entry{}, Installation{}, ErrNotFound
}
func (s *Store) Select(ctx context.Context, sid string, e Entry) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO marketplace_selections(sid,series_id,entry_id) VALUES(?,?,?) ON CONFLICT(sid,series_id) DO UPDATE SET entry_id=excluded.entry_id`, sid, e.SeriesID, e.ID)
	return err
}

func (s *Store) Catalog(ctx context.Context, viewer, sid string) ([]Entry, error) {
	versions, err := s.Versions(ctx, "", false)
	if err != nil {
		return nil, err
	}
	out := []Entry{}
	seen := map[string]bool{}
	for _, e := range versions {
		if seen[e.SeriesID] {
			continue
		}
		seen[e.SeriesID] = true
		e.CanDelete = e.Publisher == viewer
		old, installed, err := s.Selection(ctx, sid, e.SeriesID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err == nil && installed.Complete {
			e.Installed = true
			e.SelectedID = old.ID
			e.InstalledVersion = old.Version
			e.UpdateAvailable = Newer(e.Version, old.Version)
		}
		_, b, err := s.Get(ctx, e.ID)
		if err != nil {
			return nil, err
		}
		e.Skills = []string{}
		e.MCP = []string{}
		for _, v := range b.Skills {
			e.Skills = append(e.Skills, v.Name)
		}
		for _, v := range b.MCP {
			e.MCP = append(e.MCP, v.Name)
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

type Subscription struct {
	ProjectID string `json:"projectId"`
	SeriesID  string `json:"seriesId"`
	EntryID   string `json:"entryId"`
}

func (s *Store) Subscribe(ctx context.Context, project string, e Entry) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO marketplace_subscriptions(project_id,series_id,entry_id) VALUES(?,?,?) ON CONFLICT(project_id,series_id) DO UPDATE SET entry_id=excluded.entry_id`, project, e.SeriesID, e.ID)
	return err
}
func (s *Store) Unsubscribe(ctx context.Context, project, series string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM marketplace_subscriptions WHERE project_id=? AND series_id=?`, project, series)
	return err
}
func (s *Store) Subscriptions(ctx context.Context, project string) ([]Subscription, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT project_id,series_id,entry_id FROM marketplace_subscriptions WHERE project_id=? ORDER BY series_id`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Subscription{}
	for rows.Next() {
		var v Subscription
		if err = rows.Scan(&v.ProjectID, &v.SeriesID, &v.EntryID); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type Action struct {
	ID        string         `json:"id"`
	SeriesID  string         `json:"seriesId"`
	TargetID  string         `json:"targetId"`
	Action    string         `json:"action"`
	Reason    string         `json:"reason"`
	Actor     string         `json:"actor"`
	CreatedAt string         `json:"createdAt"`
	Targets   []ActionTarget `json:"targets"`
}
type ActionTarget struct {
	SID   string `json:"sid"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
}

func (s *Store) CreateAction(ctx context.Context, a Action) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if a.Action == "update" {
		var valid int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM marketplace_entries WHERE id=? AND series_id=? AND revoked=0 AND listed=1`, a.TargetID, a.SeriesID).Scan(&valid); err != nil {
			return err
		}
		if valid != 1 {
			return errors.New("invalid_market_update_target")
		}
	}
	// A later security decision supersedes unfinished older work for this capability.
	_, err = tx.ExecContext(ctx, `UPDATE marketplace_action_targets SET state='superseded',error='' WHERE state='pending' AND action_id IN (SELECT id FROM marketplace_actions WHERE series_id=?)`, a.SeriesID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO marketplace_actions(id,series_id,target_id,action,reason,actor,created_at) VALUES(?,?,?,?,?,?,?)`, a.ID, a.SeriesID, a.TargetID, a.Action, a.Reason, a.Actor, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	for _, t := range a.Targets {
		if _, err = tx.ExecContext(ctx, `INSERT INTO marketplace_action_targets(action_id,sid) VALUES(?,?)`, a.ID, t.SID); err != nil {
			return err
		}
	}
	if a.Action == "delete" || a.Action == "disable" {
		_, err = tx.ExecContext(ctx, `UPDATE marketplace_entries SET revoked=1 WHERE series_id=?`, a.SeriesID)
	}
	if a.Action == "unlist" || a.Action == "relist" {
		listed := 0
		if a.Action == "relist" {
			listed = 1
		}
		_, err = tx.ExecContext(ctx, `UPDATE marketplace_entries SET listed=? WHERE series_id=?`, listed, a.SeriesID)
	}
	if a.Action == "update" {
		_, err = tx.ExecContext(ctx, `UPDATE marketplace_entries SET revoked=1 WHERE series_id=? AND id<>?`, a.SeriesID, a.TargetID)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) Actions(ctx context.Context) ([]Action, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,series_id,target_id,action,reason,actor,created_at FROM marketplace_actions ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	out := []Action{}
	for rows.Next() {
		var a Action
		if err = rows.Scan(&a.ID, &a.SeriesID, &a.TargetID, &a.Action, &a.Reason, &a.Actor, &a.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		a.Targets = []ActionTarget{}
		out = append(out, a)
	}
	rows.Close()
	for i := range out {
		rows, err = s.db.QueryContext(ctx, `SELECT sid,state,error FROM marketplace_action_targets WHERE action_id=?`, out[i].ID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var t ActionTarget
			if err = rows.Scan(&t.SID, &t.State, &t.Error); err != nil {
				rows.Close()
				return nil, err
			}
			out[i].Targets = append(out[i].Targets, t)
		}
		rows.Close()
	}
	return out, nil
}
func (s *Store) FinishTarget(ctx context.Context, id, sid, state, reason string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE marketplace_action_targets SET state=?,error=? WHERE action_id=? AND sid=?`, state, reason, id, sid)
	return err
}
func (s *Store) InstalledVersions(ctx context.Context, sid, series string) (map[string]Installation, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT i.entry_id,i.state FROM marketplace_installations i JOIN marketplace_entries e ON e.id=i.entry_id WHERE i.sid=? AND e.series_id=?`, sid, series)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Installation{}
	for rows.Next() {
		var id, raw string
		if err = rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		var v Installation
		if err = json.Unmarshal([]byte(raw), &v); err != nil {
			return nil, err
		}
		out[id] = v
	}
	return out, rows.Err()
}
func (s *Store) ApplyProjectAction(ctx context.Context, a Action) error {
	if a.Action == "update" {
		_, err := s.db.ExecContext(ctx, `UPDATE marketplace_subscriptions SET entry_id=? WHERE series_id=?`, a.TargetID, a.SeriesID)
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM marketplace_subscriptions WHERE series_id=?`, a.SeriesID)
	return err
}
