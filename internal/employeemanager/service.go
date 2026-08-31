package employeemanager

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/contracts"
	"workagent3/internal/employee"
	"workagent3/internal/store"
	"workagent3/internal/winutil"
)

type UserStore interface {
	ListManagedUsers(context.Context) ([]store.User, error)
}

type Service struct {
	Provisioner *employee.Provisioner
	Lifecycle   employee.Lifecycle
	Users       UserStore

	mu   sync.Mutex
	jobs map[string]contracts.EmployeeProvisionJob
}

func (s *Service) ListManagedUsers(ctx context.Context) ([]contracts.ManagedEmployee, []string, error) {
	if s.Users == nil {
		return nil, nil, errors.New("employee user store is required")
	}
	users, err := s.Users.ListManagedUsers(ctx)
	if err != nil {
		return nil, nil, err
	}
	items := make([]contracts.ManagedEmployee, 0, len(users))
	for _, user := range users {
		items = append(items, contracts.ManagedEmployee{Username: user.Username, WindowsUsername: user.Username, WindowsSID: user.SID, Enabled: !user.Disabled, CreatedAt: user.CreatedAt, LastLoginAt: user.LastLoginAt})
	}
	return items, nil, nil
}

func (s *Service) StartProvision(_ context.Context, username string, password []byte) (contracts.EmployeeProvisionJob, error) {
	if s.Provisioner == nil {
		return contracts.EmployeeProvisionJob{}, errors.New("employee provisioner is required")
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		return contracts.EmployeeProvisionJob{}, err
	}
	job := contracts.EmployeeProvisionJob{ID: id, Username: username, Status: "running", Percent: 5, Step: "queued"}
	s.mu.Lock()
	if s.jobs == nil {
		s.jobs = make(map[string]contracts.EmployeeProvisionJob)
	}
	for _, existing := range s.jobs {
		if existing.Status == "running" && strings.EqualFold(existing.Username, username) {
			s.mu.Unlock()
			return contracts.EmployeeProvisionJob{}, errors.New("account creation is already in progress")
		}
	}
	s.jobs[id] = job
	s.mu.Unlock()
	secret := append([]byte(nil), password...)
	go s.runProvision(job, secret)
	return job, nil
}

func (s *Service) runProvision(job contracts.EmployeeProvisionJob, password []byte) {
	defer zero(password)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	s.updateJob(job.ID, 20, "configuring_windows_account")
	_, err := s.Provisioner.Add(ctx, job.Username, password)
	if err != nil {
		s.mu.Lock()
		current := s.jobs[job.ID]
		current.Status, current.Step, current.ErrorCode, current.ErrorMessage = "failed", "failed", "PROVISION_FAILED", err.Error()
		s.jobs[job.ID] = current
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	current := s.jobs[job.ID]
	current.Status, current.Percent, current.Step = "succeeded", 100, "completed"
	s.jobs[job.ID] = current
	s.mu.Unlock()
}

func (s *Service) updateJob(id string, percent int, step string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job.Status == "running" {
		job.Percent, job.Step = percent, step
		s.jobs[id] = job
	}
}

func (s *Service) ProvisionJob(_ context.Context, id string) (contracts.EmployeeProvisionJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return contracts.EmployeeProvisionJob{}, errors.New("provision job not found")
	}
	return job, nil
}

func (s *Service) ManagedUsersUsage(ctx context.Context) ([]contracts.ManagedEmployeeUsage, error) {
	users, _, err := s.ListManagedUsers(ctx)
	if err != nil {
		return nil, err
	}
	usage := make([]contracts.ManagedEmployeeUsage, 0, len(users))
	for _, user := range users {
		usage = append(usage, contracts.ManagedEmployeeUsage{Username: user.Username, ResourceUsageUnavailable: true})
	}
	return usage, nil
}

func (s *Service) SetEnabled(ctx context.Context, username string, enabled bool) error {
	_, err := s.Lifecycle.SetEnabled(ctx, username, enabled)
	return err
}

func (s *Service) ResetPassword(ctx context.Context, username string, password []byte) error {
	return s.Lifecycle.ResetPortalPassword(ctx, username, password)
}

func (s *Service) SetLimits(ctx context.Context, username string, limits winutil.JobLimits) error {
	_, err := s.Lifecycle.SetLimits(ctx, username, limits)
	return err
}

func (*Service) SetKimiDatasource(context.Context, string, contracts.KimiDatasourceGrant) (contracts.KimiDatasourceGrant, error) {
	return contracts.KimiDatasourceGrant{}, fmt.Errorf("Kimi datasource policy is not configured")
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
