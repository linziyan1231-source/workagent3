package portal

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"workagent3/internal/contracts"
	"workagent3/internal/marketplace"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/store"
)

const professionalDatabaseService = "professional-database"
const professionalDatabaseMarketID = "professional-database-1.0.0"

type ProfessionalDatabasePort interface {
	ProfessionalDatabaseStatus(context.Context, string) (contracts.ProfessionalDatabaseStatus, error)
	ProfessionalDatabaseConnection(context.Context, string) (contracts.ProfessionalDatabaseConnection, error)
}

func (c *EmployeeManagerClient) ProfessionalDatabaseStatus(ctx context.Context, sid string) (contracts.ProfessionalDatabaseStatus, error) {
	var result contracts.ProfessionalDatabaseStatus
	err := c.call(ctx, http.MethodGet, "/v1/professional-database/"+url.PathEscape(sid), nil, &result)
	return result, professionalDatabaseError(err)
}

func (c *EmployeeManagerClient) ProfessionalDatabaseConnection(ctx context.Context, sid string) (contracts.ProfessionalDatabaseConnection, error) {
	var result contracts.ProfessionalDatabaseConnection
	err := c.call(ctx, http.MethodPost, "/v1/professional-database/"+url.PathEscape(sid)+"/connection", nil, &result)
	return result, professionalDatabaseError(err)
}

func professionalDatabaseError(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "professional_database_disabled") {
		return errors.New("professional_database_disabled")
	}
	return errors.New("professional_database_unavailable")
}

func containsProfessionalDatabase(b marketplace.Bundle) bool {
	for _, m := range b.MCP {
		if m.ManagedService == professionalDatabaseService {
			return true
		}
	}
	return false
}

func (s *Server) professionalDatabaseDetail(ctx context.Context, sid string, b marketplace.Bundle) (*contracts.ProfessionalDatabaseStatus, error) {
	if !containsProfessionalDatabase(b) {
		return nil, nil
	}
	if s.modules.ProfessionalDatabase == nil {
		return &contracts.ProfessionalDatabaseStatus{Timezone: "Asia/Shanghai", KimiDatasourceGrant: contracts.KimiDatasourceGrant{AllowedSources: []string{}}}, nil
	}
	status, err := s.modules.ProfessionalDatabase.ProfessionalDatabaseStatus(ctx, sid)
	return &status, err
}

// Publishing is an explicit administrator action. The public bundle contains
// a service reference; the receiving employee gets their own connection later.
func (s *Server) publishProfessionalDatabase(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Marketplace == nil || s.modules.ProfessionalDatabase == nil {
		writeError(w, 503, "professional_database_unavailable")
		return
	}
	status, err := s.modules.ProfessionalDatabase.ProfessionalDatabaseStatus(r.Context(), user.SID)
	if err != nil || !status.Configured {
		writeError(w, 503, "professional_database_unavailable")
		return
	}
	if existing, _, err := s.modules.Marketplace.Get(r.Context(), professionalDatabaseMarketID); err == nil {
		writeJSON(w, 200, map[string]any{"entry": existing})
		return
	} else if !errors.Is(err, marketplace.ErrNotFound) {
		marketError(w, err)
		return
	}
	entry := marketplace.Entry{ID: professionalDatabaseMarketID, Kind: "mcp", Name: "专业数据库", Version: "1.0.0", Publisher: user.Username,
		Description:  "通过 Kimi 专业数据服务查询金融行情、企业工商、宏观经济、学术文献、法律法规及官方统计。由管理员按账户授权和管理调用次数。",
		ReleaseNotes: "独立专业数据库服务；25 个数据源；按员工控制权限及每日、每月调用次数；详情显示剩余次数与总次数。"}
	bundle := marketplace.Bundle{Skills: []marketplace.Skill{}, MCP: []marketplace.Connector{{ID: professionalDatabaseService, Name: "专业数据库", ManagedService: professionalDatabaseService, Description: entry.Description, ToolPolicy: "all", AllowedTools: []string{}, CredentialNames: []string{}}}}
	if err := s.modules.Marketplace.Publish(r.Context(), entry, bundle); err != nil {
		marketError(w, err)
		return
	}
	s.recordBusinessEvent(r.Context(), user.SID, "market.publish", entry.ID, nil, map[string]string{"kind": "mcp", "name": entry.Name, "version": entry.Version})
	writeJSON(w, 201, map[string]any{"entry": entry})
}

func (s *Server) installProfessionalDatabase(ctx context.Context, remote marketRuntime, user store.User, entry marketplace.Entry, m marketplace.Connector, currentID string) (string, error) {
	if m.ManagedService != professionalDatabaseService || s.modules.ProfessionalDatabase == nil {
		return "", errors.New("professional_database_unavailable")
	}
	connection, err := s.modules.ProfessionalDatabase.ProfessionalDatabaseConnection(ctx, user.SID)
	if err != nil {
		return "", err
	}
	defer func() { connection.Token = "" }()
	if currentID != "" {
		return currentID, nil
	}
	var credential struct {
		ID string `json:"id"`
	}
	err = remote.call(ctx, "POST", "/v1/credentials", map[string]any{"kind": "mcp_header", "label": "专业数据库 / 当前账户", "secret": "Bearer " + connection.Token}, &credential)
	if err != nil {
		return "", err
	}
	var created mcpruntime.Server
	transport := mcpruntime.Transport{ManagedService: professionalDatabaseService, Kind: "http", URL: connection.Endpoint, HeaderCredentialIDs: map[string]string{"Authorization": credential.ID}}
	err = remote.call(ctx, "POST", "/v1/mcp-servers", map[string]any{"name": m.Name + " [" + entry.ID[:8] + "]", "description": m.Description, "source": "user", "enabled": true, "transport": transport, "toolPolicy": "all", "allowedTools": []string{}, "oauthState": "none"}, &created)
	if err != nil {
		_ = remote.call(ctx, "DELETE", "/v1/credentials/"+url.PathEscape(credential.ID), nil, nil)
	}
	return created.ID, err
}
