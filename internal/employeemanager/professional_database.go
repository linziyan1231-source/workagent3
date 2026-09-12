package employeemanager

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"workagent3/internal/contracts"
	"workagent3/internal/professionaldb"
)

func (s *Service) ProfessionalDatabaseEnabled(ctx context.Context, sid string) (bool, error) {
	user, err := s.Users.UserBySID(ctx, sid)
	if err != nil {
		return false, err
	}
	return !user.Disabled && !user.Offboarded, nil
}

func (s *Service) ProfessionalDatabaseStatus(ctx context.Context, sid string) (contracts.ProfessionalDatabaseStatus, error) {
	status := contracts.ProfessionalDatabaseStatus{Timezone: "Asia/Shanghai", CountingRule: "接口说明和数据查询每次发往上游计 1 次；已发出的失败请求计次，连接检查与权限拒绝不计次。"}
	status.AllowedSources = []string{}
	if s.ProfessionalDatabase == nil {
		return status, nil
	}
	if _, err := s.Users.UserBySID(ctx, sid); err != nil {
		return status, err
	}
	grant, err := s.ProfessionalDatabase.Grant(ctx, sid)
	if err != nil {
		return status, err
	}
	status.KimiDatasourceGrant, status.Configured = grant, true
	if s.ProfessionalDatabaseReady != nil {
		status.UpstreamReady = s.ProfessionalDatabaseReady()
	}
	status.DailyRemaining = max(0, grant.DailyLimit-grant.DailyUsed)
	status.MonthlyRemaining = max(0, grant.MonthlyLimit-grant.MonthlyUsed)
	return status, nil
}

func (s *Service) professionalDatabaseConnection(ctx context.Context, sid string) (contracts.ProfessionalDatabaseConnection, error) {
	if s.ProfessionalDatabase == nil {
		return contracts.ProfessionalDatabaseConnection{}, errors.New("professional_database_unavailable")
	}
	enabled, err := s.ProfessionalDatabaseEnabled(ctx, sid)
	if err != nil {
		return contracts.ProfessionalDatabaseConnection{}, err
	}
	status, err := s.ProfessionalDatabaseStatus(ctx, sid)
	if err != nil {
		return contracts.ProfessionalDatabaseConnection{}, err
	}
	if !enabled || !status.Enabled {
		return contracts.ProfessionalDatabaseConnection{}, errors.New("professional_database_disabled")
	}
	token, err := s.ProfessionalDatabase.IssueToken(ctx, sid)
	return contracts.ProfessionalDatabaseConnection{Endpoint: s.ProfessionalDatabaseURL, Token: token}, err
}

func (s *Service) setProfessionalDatabase(ctx context.Context, username string, grant contracts.KimiDatasourceGrant) (contracts.KimiDatasourceGrant, error) {
	if s.ProfessionalDatabase == nil {
		return contracts.KimiDatasourceGrant{}, errors.New("professional_database_unavailable")
	}
	users, err := s.Users.ListManagedUsers(ctx)
	if err != nil {
		return contracts.KimiDatasourceGrant{}, err
	}
	for _, user := range users {
		if !strings.EqualFold(user.Username, username) {
			continue
		}
		if user.Offboarded {
			return contracts.KimiDatasourceGrant{}, errors.New("employee_unavailable")
		}
		updated, err := s.ProfessionalDatabase.SetGrant(ctx, user.SID, grant)
		s.record(ctx, "professional_database.policy", user.SID, err, nil)
		return updated, err
	}
	return contracts.KimiDatasourceGrant{}, errors.New("employee_not_found")
}

func (s *Service) professionalDatabaseHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		value, err := s.ProfessionalDatabaseStatus(r.Context(), r.PathValue("sid"))
		respond(w, value, err)
		return
	}
	connection, err := s.professionalDatabaseConnection(r.Context(), r.PathValue("sid"))
	respond(w, connection, err)
	connection.Token = ""
}

func professionalDatabaseSources(service *Service) []string {
	if service.ProfessionalDatabase == nil {
		return nil
	}
	return append([]string(nil), professionaldb.Sources...)
}
