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
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound             = errors.New("MCP server not found")
	ErrUnsupportedTransport = errors.New("MCP transport is not supported by engine")
	ErrServerUnavailable    = errors.New("MCP server is unavailable")
)

type Transport struct {
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
	return nil
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
			if server.Source != "managed" || endpoint.Scheme != "http" || !net.ParseIP(host).IsLoopback() {
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
