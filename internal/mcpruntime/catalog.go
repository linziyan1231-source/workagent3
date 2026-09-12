package mcpruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound             = errors.New("MCP server not found")
	ErrUnsupportedTransport = errors.New("MCP transport is not supported by engine")
	ErrServerUnavailable    = errors.New("MCP server is unavailable")
)

var (
	environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	headerName      = regexp.MustCompile("^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
)

type Transport struct {
	ManagedService           string            `json:"managedService,omitempty"`
	GlobalSource             string            `json:"globalSource,omitempty"`
	NativeName               string            `json:"nativeName,omitempty"`
	Kind                     string            `json:"kind"`
	Command                  string            `json:"command,omitempty"`
	Args                     []string          `json:"args,omitempty"`
	URL                      string            `json:"url,omitempty"`
	EnvironmentCredentialIDs map[string]string `json:"environmentCredentialIds,omitempty"`
	HeaderCredentialIDs      map[string]string `json:"headerCredentialIds,omitempty"`
}

type Server struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description,omitempty"`
	Source       string    `json:"source"`
	Enabled      bool      `json:"enabled"`
	Transport    Transport `json:"transport"`
	ToolPolicy   string    `json:"toolPolicy"`
	AllowedTools []string  `json:"allowedTools"`
	OAuthState   string    `json:"oauthState"`
	Health       string    `json:"health"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type Catalog struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Catalog, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open MCP catalog: %w", err)
	}
	database.SetMaxOpenConns(1)
	catalog := &Catalog{db: database, now: time.Now}
	if err := catalog.migrate(context.Background()); err != nil {
		database.Close()
		return nil, err
	}
	return catalog, nil
}

func (c *Catalog) Close() error { return c.db.Close() }

func (c *Catalog) migrate(ctx context.Context) error {
	_, err := c.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('managed','user')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  transport_json TEXT NOT NULL CHECK (json_valid(transport_json)),
  tool_policy TEXT NOT NULL CHECK (tool_policy IN ('all','allowlist','none')),
  allowed_tools_json TEXT NOT NULL CHECK (json_valid(allowed_tools_json)),
  oauth_state TEXT NOT NULL CHECK (oauth_state IN ('none','ready','needs_auth')),
  health TEXT NOT NULL CHECK (health IN ('unknown','healthy','unavailable','needs_review')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`)
	if err != nil {
		return fmt.Errorf("migrate MCP catalog: %w", err)
	}
	_, err = c.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS native_mcp_names (name TEXT PRIMARY KEY, transport_json TEXT NOT NULL)`)
	return err
}

func (c *Catalog) RememberNativeName(ctx context.Context, name string, transport Transport) error {
	config := map[string]any{"enabled": false}
	if transport.Kind == "stdio" {
		config["command"], config["args"] = transport.Command, transport.Args
	} else {
		config["url"] = transport.URL
	}
	encoded, _ := json.Marshal(config)
	_, err := c.db.ExecContext(ctx, `INSERT INTO native_mcp_names(name,transport_json) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET transport_json=excluded.transport_json`, name, string(encoded))
	return err
}

func (c *Catalog) NativeConfig(ctx context.Context) (map[string]map[string]any, error) {
	rows, err := c.db.QueryContext(ctx, `SELECT name,transport_json FROM native_mcp_names ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	config := map[string]map[string]any{}
	for rows.Next() {
		var name, data string
		if err := rows.Scan(&name, &data); err != nil {
			return nil, err
		}
		var value map[string]any
		if err := json.Unmarshal([]byte(data), &value); err != nil {
			return nil, err
		}
		config[name] = value
	}
	return config, rows.Err()
}

func (c *Catalog) NativeNames(ctx context.Context) ([]string, error) {
	rows, err := c.db.QueryContext(ctx, `SELECT name FROM native_mcp_names ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func (c *Catalog) Create(ctx context.Context, server Server) (Server, error) {
	if err := validateServer(server); err != nil {
		return Server{}, err
	}
	transport, _ := json.Marshal(server.Transport)
	allowedTools, _ := json.Marshal(server.AllowedTools)
	stamp := c.now().UnixMilli()
	_, err := c.db.ExecContext(ctx, `INSERT INTO mcp_servers
(id,name,description,source,enabled,transport_json,tool_policy,allowed_tools_json,oauth_state,health,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, server.ID, strings.TrimSpace(server.Name), strings.TrimSpace(server.Description), server.Source,
		server.Enabled, string(transport), server.ToolPolicy, string(allowedTools), server.OAuthState, server.Health, stamp, stamp)
	if err != nil {
		return Server{}, fmt.Errorf("create MCP server: %w", err)
	}
	return c.Get(ctx, server.ID)
}

func (c *Catalog) Replace(ctx context.Context, server Server) (Server, error) {
	if err := validateServer(server); err != nil {
		return Server{}, err
	}
	transport, _ := json.Marshal(server.Transport)
	allowedTools, _ := json.Marshal(server.AllowedTools)
	result, err := c.db.ExecContext(ctx, `UPDATE mcp_servers SET name=?,description=?,source=?,enabled=?,transport_json=?,tool_policy=?,allowed_tools_json=?,oauth_state=?,health=?,updated_at=? WHERE id=?`,
		strings.TrimSpace(server.Name), strings.TrimSpace(server.Description), server.Source, server.Enabled, string(transport), server.ToolPolicy,
		string(allowedTools), server.OAuthState, server.Health, c.now().UnixMilli(), server.ID)
	if err != nil {
		return Server{}, fmt.Errorf("update MCP server: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return Server{}, ErrNotFound
	}
	return c.Get(ctx, server.ID)
}

// SyncManaged atomically reconciles the managed portion of a SID catalog with
// the definitions supplied by the active release. User-owned servers are
// never changed or removed.
func (c *Catalog) SyncManaged(ctx context.Context, servers []Server) error {
	seenIDs, seenNames := map[string]struct{}{}, map[string]struct{}{}
	for _, server := range servers {
		name := strings.ToLower(strings.TrimSpace(server.Name))
		if server.Source != "managed" {
			return errors.New("managed MCP release contains another source")
		}
		if err := validateServer(server); err != nil {
			return err
		}
		if _, duplicate := seenIDs[server.ID]; duplicate {
			return errors.New("duplicate managed MCP id")
		}
		if _, duplicate := seenNames[name]; duplicate {
			return errors.New("duplicate managed MCP name")
		}
		seenIDs[server.ID], seenNames[name] = struct{}{}, struct{}{}
	}
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return fmt.Errorf("sync managed MCP servers: %w", err)
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id FROM mcp_servers WHERE source='managed'`)
	if err != nil {
		return fmt.Errorf("list managed MCP servers: %w", err)
	}
	var removed []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		if _, retained := seenIDs[id]; !retained {
			removed = append(removed, id)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range removed {
		if _, err := tx.ExecContext(ctx, `DELETE FROM mcp_servers WHERE id=? AND source='managed'`, id); err != nil {
			return fmt.Errorf("remove retired managed MCP server: %w", err)
		}
	}
	stamp := c.now().UnixMilli()
	for _, server := range servers {
		transport, _ := json.Marshal(server.Transport)
		allowedTools, _ := json.Marshal(server.AllowedTools)
		var source string
		err := tx.QueryRowContext(ctx, `SELECT source FROM mcp_servers WHERE id=?`, server.ID).Scan(&source)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			_, err = tx.ExecContext(ctx, `INSERT INTO mcp_servers
(id,name,description,source,enabled,transport_json,tool_policy,allowed_tools_json,oauth_state,health,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, server.ID, strings.TrimSpace(server.Name), strings.TrimSpace(server.Description), server.Source,
				server.Enabled, string(transport), server.ToolPolicy, string(allowedTools), server.OAuthState, server.Health, stamp, stamp)
		case err != nil:
			return fmt.Errorf("inspect managed MCP server: %w", err)
		case source != "managed":
			return errors.New("managed MCP conflicts with a user server")
		default:
			_, err = tx.ExecContext(ctx, `UPDATE mcp_servers SET name=?,description=?,enabled=?,transport_json=?,tool_policy=?,allowed_tools_json=?,oauth_state=?,health=?,updated_at=? WHERE id=? AND source='managed'`,
				strings.TrimSpace(server.Name), strings.TrimSpace(server.Description), server.Enabled, string(transport), server.ToolPolicy,
				string(allowedTools), server.OAuthState, server.Health, stamp, server.ID)
		}
		if err != nil {
			return fmt.Errorf("sync managed MCP server %s: %w", server.ID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit managed MCP servers: %w", err)
	}
	return nil
}

func (c *Catalog) Get(ctx context.Context, id string) (Server, error) {
	return scanServer(c.db.QueryRowContext(ctx, mcpSelect+` WHERE id=?`, id))
}

func (c *Catalog) List(ctx context.Context) ([]Server, error) {
	rows, err := c.db.QueryContext(ctx, mcpSelect+` ORDER BY name,id`)
	if err != nil {
		return nil, fmt.Errorf("list MCP servers: %w", err)
	}
	defer rows.Close()
	servers := make([]Server, 0)
	for rows.Next() {
		server, err := scanServer(rows)
		if err != nil {
			return nil, err
		}
		servers = append(servers, server)
	}
	return servers, rows.Err()
}

func (c *Catalog) Delete(ctx context.Context, id string) error {
	result, err := c.db.ExecContext(ctx, `DELETE FROM mcp_servers WHERE id=?`, id)
	if err != nil {
		return fmt.Errorf("delete MCP server: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return ErrNotFound
	}
	return nil
}

const mcpSelect = `SELECT id,name,description,source,enabled,transport_json,tool_policy,allowed_tools_json,oauth_state,health,created_at,updated_at FROM mcp_servers`

type scanner interface{ Scan(...any) error }

func scanServer(row scanner) (Server, error) {
	var server Server
	var enabled int
	var transportJSON, toolsJSON string
	var createdAt, updatedAt int64
	err := row.Scan(&server.ID, &server.Name, &server.Description, &server.Source, &enabled, &transportJSON, &server.ToolPolicy,
		&toolsJSON, &server.OAuthState, &server.Health, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Server{}, ErrNotFound
	}
	if err != nil {
		return Server{}, err
	}
	if err := json.Unmarshal([]byte(transportJSON), &server.Transport); err != nil {
		return Server{}, fmt.Errorf("decode MCP transport: %w", err)
	}
	if err := json.Unmarshal([]byte(toolsJSON), &server.AllowedTools); err != nil {
		return Server{}, fmt.Errorf("decode MCP tool policy: %w", err)
	}
	server.Enabled = enabled == 1
	server.CreatedAt = time.UnixMilli(createdAt).UTC()
	server.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	return server, nil
}

func validateServer(server Server) error {
	if server.ID == "" || strings.TrimSpace(server.Name) == "" || len(server.Name) > 120 || len(server.Description) > 1000 ||
		(server.Source != "managed" && server.Source != "user") ||
		(server.OAuthState != "none" && server.OAuthState != "ready" && server.OAuthState != "needs_auth") ||
		(server.Health != "unknown" && server.Health != "healthy" && server.Health != "unavailable" && server.Health != "needs_review") {
		return errors.New("invalid MCP server metadata")
	}
	if server.ToolPolicy != "all" && server.ToolPolicy != "allowlist" && server.ToolPolicy != "none" {
		return errors.New("invalid MCP tool policy")
	}
	if (server.ToolPolicy == "allowlist") != (len(server.AllowedTools) > 0) {
		return errors.New("MCP allowlist policy and tools do not match")
	}
	if server.ToolPolicy != "allowlist" && len(server.AllowedTools) != 0 {
		return errors.New("MCP tools are only valid with allowlist policy")
	}
	for name, id := range server.Transport.EnvironmentCredentialIDs {
		if !environmentName.MatchString(name) || id == "" {
			return errors.New("invalid MCP environment credential reference")
		}
	}
	for name, id := range server.Transport.HeaderCredentialIDs {
		if !headerName.MatchString(name) || id == "" {
			return errors.New("invalid MCP header credential reference")
		}
	}
	switch server.Transport.Kind {
	case "stdio":
		if !filepath.IsAbs(server.Transport.Command) || server.Transport.URL != "" || len(server.Transport.HeaderCredentialIDs) != 0 {
			return errors.New("invalid stdio MCP transport")
		}
	case "http", "sse":
		endpoint, err := url.Parse(server.Transport.URL)
		if err != nil || endpoint.Host == "" || server.Transport.Command != "" || len(server.Transport.EnvironmentCredentialIDs) != 0 {
			return errors.New("invalid remote MCP transport")
		}
		if endpoint.Scheme != "https" {
			host := endpoint.Hostname()
			if endpoint.Scheme != "http" || (!net.ParseIP(host).IsLoopback() && !strings.EqualFold(host, "localhost")) {
				return errors.New("remote MCP endpoint must use HTTPS")
			}
		}
	default:
		return errors.New("unknown MCP transport")
	}
	return nil
}

type EngineCapabilities struct {
	Engine string
	Stdio  bool
	HTTP   bool
	SSE    bool
}

func Project(servers []Server, capabilities EngineCapabilities) ([]Server, error) {
	projected := make([]Server, 0, len(servers))
	for _, server := range servers {
		if !server.Enabled {
			continue
		}
		if server.OAuthState == "needs_auth" || server.Health == "unavailable" || server.Health == "needs_review" {
			return nil, fmt.Errorf("%w: %s", ErrServerUnavailable, server.ID)
		}
		supported := (server.Transport.Kind == "stdio" && capabilities.Stdio) ||
			(server.Transport.Kind == "http" && capabilities.HTTP) ||
			(server.Transport.Kind == "sse" && capabilities.SSE)
		if !supported {
			return nil, fmt.Errorf("%w: %s:%s", ErrUnsupportedTransport, capabilities.Engine, server.Transport.Kind)
		}
		projected = append(projected, server)
	}
	return projected, nil
}
