package marketplace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	_ "modernc.org/sqlite"
	"strings"
	"sync"
	"time"
	"workagent3/internal/mcpruntime"
)

var ErrNotFound = errors.New("market_entry_not_found")
var ErrForbidden = errors.New("market_forbidden")

type Skill struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Version     string   `json:"version"`
	Builtin     bool     `json:"builtin,omitempty"`
	Archive     []byte   `json:"archive,omitempty"`
	RequiredMCP []string `json:"requiredMcpServerIds,omitempty"`
}
type Connector struct {
	ManagedService  string               `json:"managedService,omitempty"`
	ID              string               `json:"id"`
	Name            string               `json:"name"`
	Description     string               `json:"description"`
	Transport       mcpruntime.Transport `json:"transport"`
	ToolPolicy      string               `json:"toolPolicy"`
	AllowedTools    []string             `json:"allowedTools"`
	CredentialNames []string             `json:"credentialNames"`
	OAuth           bool                 `json:"oauth"`
	Builtin         bool                 `json:"builtin,omitempty"`
}
type Assistant struct {
	Name            string   `json:"name"`
	Engine          string   `json:"engine"`
	Description     string   `json:"description"`
	SystemPrompt    string   `json:"systemPrompt"`
	WorkspacePolicy string   `json:"workspacePolicy"`
	SkillIDs        []string `json:"skillIds"`
	MCPServerIDs    []string `json:"mcpServerIds"`
	ToolAllowlist   []string `json:"toolAllowlist"`
	ApprovalPolicy  string   `json:"approvalPolicy"`
}
type Bundle struct {
	Skills    []Skill     `json:"skills"`
	MCP       []Connector `json:"mcp"`
	Assistant *Assistant  `json:"assistant,omitempty"`
}
type Entry struct {
	ID               string    `json:"id"`
	Kind             string    `json:"kind"`
	Name             string    `json:"name"`
	Description      string    `json:"description"`
	Version          string    `json:"version"`
	Publisher        string    `json:"publisher"`
	CreatedAt        time.Time `json:"createdAt"`
	Skills           []string  `json:"skills"`
	MCP              []string  `json:"mcp"`
	CanDelete        bool      `json:"canDelete"`
	Installed        bool      `json:"installed"`
	SeriesID         string    `json:"seriesId"`
	ReleaseNotes     string    `json:"releaseNotes"`
	Revoked          bool      `json:"revoked"`
	DefaultEnabled   bool      `json:"defaultEnabled"`
	Listed           bool      `json:"listed,omitempty"`
	InstalledVersion string    `json:"installedVersion,omitempty"`
	SelectedID       string    `json:"selectedId,omitempty"`
	UpdateAvailable  bool      `json:"updateAvailable"`
}
type Installation struct {
	Skills      map[string]string `json:"skills"`
	MCP         map[string]string `json:"mcp"`
	AssistantID string            `json:"assistantId,omitempty"`
	Complete    bool              `json:"complete"`
	NeedsSetup  bool              `json:"needsSetup,omitempty"`
}
type Store struct {
	db        *sql.DB
	InstallMu sync.Mutex
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS marketplace_entries(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,version TEXT NOT NULL,publisher TEXT NOT NULL,created_at TEXT NOT NULL,bundle BLOB NOT NULL,listed INTEGER NOT NULL DEFAULT 1, UNIQUE(publisher,kind,name,version));
 CREATE TABLE IF NOT EXISTS marketplace_installations(sid TEXT NOT NULL,entry_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(sid,entry_id));`)
	if err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrateVersions(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }
func (s *Store) Publish(ctx context.Context, e Entry, b Bundle) error {
	if e.ID == "" || e.Publisher == "" || strings.TrimSpace(e.Name) == "" || len(e.Name) > 240 || len(e.Description) > 4096 || e.Version == "" || (e.Kind != "skill" && e.Kind != "mcp" && e.Kind != "assistant") {
		return errors.New("invalid_market_entry")
	}
	data, err := json.Marshal(b)
	if err != nil {
		return err
	}
	if len(data) > 72<<20 {
		return errors.New("market_bundle_too_large")
	}
	if e.SeriesID == "" {
		_ = s.db.QueryRowContext(ctx, `SELECT series_id FROM marketplace_entries WHERE publisher=? AND kind=? AND name=? ORDER BY created_at,id LIMIT 1`, e.Publisher, e.Kind, e.Name).Scan(&e.SeriesID)
		if e.SeriesID == "" {
			e.SeriesID = e.ID
		}
	} else {
		var publisher, kind string
		if err := s.db.QueryRowContext(ctx, `SELECT publisher,kind FROM marketplace_entries WHERE series_id=? LIMIT 1`, e.SeriesID).Scan(&publisher, &kind); err != nil {
			return ErrNotFound
		}
		if publisher != e.Publisher || kind != e.Kind {
			return ErrForbidden
		}
	}
	listed := 1
	var lastAction string
	err = s.db.QueryRowContext(ctx, `SELECT action FROM marketplace_actions WHERE series_id=? AND action IN ('unlist','relist') ORDER BY created_at DESC, id DESC LIMIT 1`, e.SeriesID).Scan(&lastAction)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	// A new version must not relist a series an administrator has unlisted.
	if lastAction == "unlist" {
		listed = 0
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO marketplace_entries(id,kind,name,description,version,publisher,created_at,bundle,series_id,release_notes,default_enabled,listed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, e.ID, e.Kind, e.Name, e.Description, e.Version, e.Publisher, time.Now().UTC().Format(time.RFC3339Nano), data, e.SeriesID, e.ReleaseNotes, e.DefaultEnabled, listed)
	return err
}
func (s *Store) Get(ctx context.Context, id string) (Entry, Bundle, error) {
	var e Entry
	var data []byte
	var stamp string
	err := s.db.QueryRowContext(ctx, `SELECT id,kind,name,description,version,publisher,created_at,bundle,series_id,release_notes,revoked,listed,default_enabled FROM marketplace_entries WHERE id=? AND listed=1 AND revoked=0`, id).Scan(&e.ID, &e.Kind, &e.Name, &e.Description, &e.Version, &e.Publisher, &stamp, &data, &e.SeriesID, &e.ReleaseNotes, &e.Revoked, &e.Listed, &e.DefaultEnabled)
	if errors.Is(err, sql.ErrNoRows) {
		return e, Bundle{}, ErrNotFound
	}
	if err != nil {
		return e, Bundle{}, err
	}
	e.CreatedAt, _ = time.Parse(time.RFC3339Nano, stamp)
	var b Bundle
	err = json.Unmarshal(data, &b)
	return e, b, err
}
func (s *Store) List(ctx context.Context, viewer, sid string) ([]Entry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT e.id,e.kind,e.name,e.description,e.version,e.publisher,e.created_at,e.bundle,COALESCE(i.state,'{}') FROM marketplace_entries e LEFT JOIN marketplace_installations i ON i.entry_id=e.id AND i.sid=? WHERE e.listed=1 ORDER BY e.created_at DESC`, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Entry{}
	for rows.Next() {
		var e Entry
		var stamp, state string
		var data []byte
		if err = rows.Scan(&e.ID, &e.Kind, &e.Name, &e.Description, &e.Version, &e.Publisher, &stamp, &data, &state); err != nil {
			return nil, err
		}
		var b Bundle
		if err = json.Unmarshal(data, &b); err != nil {
			return nil, err
		}
		var i Installation
		_ = json.Unmarshal([]byte(state), &i)
		e.Installed = i.Complete
		e.CanDelete = strings.EqualFold(e.Publisher, viewer)
		e.CreatedAt, _ = time.Parse(time.RFC3339Nano, stamp)
		e.Skills = []string{}
		e.MCP = []string{}
		for _, v := range b.Skills {
			e.Skills = append(e.Skills, v.Name)
		}
		for _, v := range b.MCP {
			e.MCP = append(e.MCP, v.Name)
		}
		result = append(result, e)
	}
	return result, rows.Err()
}
func (s *Store) Unpublish(ctx context.Context, id, actor string) error {
	e, _, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	if !strings.EqualFold(e.Publisher, actor) {
		return ErrForbidden
	}
	_, err = s.db.ExecContext(ctx, `UPDATE marketplace_entries SET listed=0 WHERE id=?`, id)
	return err
}
func (s *Store) Installation(ctx context.Context, sid, id string) (Installation, error) {
	i := Installation{Skills: map[string]string{}, MCP: map[string]string{}}
	var state string
	err := s.db.QueryRowContext(ctx, `SELECT state FROM marketplace_installations WHERE sid=? AND entry_id=?`, sid, id).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return i, nil
	}
	if err != nil {
		return i, err
	}
	err = json.Unmarshal([]byte(state), &i)
	return i, err
}
func (s *Store) SaveInstallation(ctx context.Context, sid, id string, i Installation) error {
	data, _ := json.Marshal(i)
	_, err := s.db.ExecContext(ctx, `INSERT INTO marketplace_installations(sid,entry_id,state) VALUES(?,?,?) ON CONFLICT(sid,entry_id) DO UPDATE SET state=excluded.state`, sid, id, string(data))
	return err
}

// Installed snapshots remain available after an author unpublishes a listing.
func (s *Store) InstalledSkill(ctx context.Context, sid, id string) (Skill, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT e.bundle,i.state FROM marketplace_installations i JOIN marketplace_entries e ON e.id=i.entry_id WHERE i.sid=?`, sid)
	if err != nil {
		return Skill{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var data []byte
		var state string
		if err = rows.Scan(&data, &state); err != nil {
			return Skill{}, err
		}
		var i Installation
		var b Bundle
		if err = json.Unmarshal([]byte(state), &i); err != nil {
			return Skill{}, err
		}
		if err = json.Unmarshal(data, &b); err != nil {
			return Skill{}, err
		}
		for source, target := range i.Skills {
			if target == id {
				for _, skill := range b.Skills {
					if skill.ID == source {
						for index, dependency := range skill.RequiredMCP {
							skill.RequiredMCP[index] = i.MCP[dependency]
						}
						return skill, nil
					}
				}
			}
		}
	}
	return Skill{}, ErrNotFound
}
