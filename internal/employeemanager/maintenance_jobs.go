package employeemanager

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"
	"workagent3/internal/auth"
	"workagent3/internal/contracts"
)

type JobStore struct{ db *sql.DB }

func OpenJobStore(path string) (*JobStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS employee_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL)"); err != nil {
		db.Close()
		return nil, err
	}
	return &JobStore{db}, nil
}
func (j *JobStore) Close() error { return j.db.Close() }
func (j *JobStore) Save(job contracts.EmployeeProvisionJob) error {
	data, _ := json.Marshal(job)
	_, err := j.db.Exec("INSERT INTO employee_jobs(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", job.ID, string(data))
	return err
}
func (s *Service) RestoreJobs() error {
	rows, err := s.Jobs.db.Query("SELECT payload FROM employee_jobs")
	if err != nil {
		return err
	}
	jobs := []contracts.EmployeeProvisionJob{}
	for rows.Next() {
		var data string
		var job contracts.EmployeeProvisionJob
		if err := rows.Scan(&data); err != nil {
			rows.Close()
			return err
		}
		if err := json.Unmarshal([]byte(data), &job); err != nil {
			rows.Close()
			return err
		}
		jobs = append(jobs, job)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	s.jobs = make(map[string]contracts.EmployeeProvisionJob)
	for _, job := range jobs {
		if job.Status == "running" {
			job.Status = "failed"
			job.ErrorCode = "MAINTENANCE_INTERRUPTED"
			job.ErrorMessage = "管理服务重启使操作中断，请检查账户状态后重试。"
			if err := s.Jobs.Save(job); err != nil {
				return err
			}
		}
		s.jobs[job.ID] = job
	}
	return nil
}

func (s *Service) StartMaintenance(ctx context.Context, action, username, newName string) (contracts.EmployeeProvisionJob, error) {
	if action != "repair" && action != "restart" && action != "rename-windows" {
		return contracts.EmployeeProvisionJob{}, errors.New("unsupported maintenance action")
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		return contracts.EmployeeProvisionJob{}, err
	}
	job := contracts.EmployeeProvisionJob{ID: id, Username: username, Status: "running", Percent: 10, Step: action}
	s.mu.Lock()
	if s.jobs == nil {
		s.jobs = make(map[string]contracts.EmployeeProvisionJob)
	}
	for _, existing := range s.jobs {
		if existing.Status == "running" && strings.EqualFold(existing.Username, username) {
			s.mu.Unlock()
			return contracts.EmployeeProvisionJob{}, errors.New("employee maintenance is already running")
		}
	}
	if s.Jobs != nil {
		if err := s.Jobs.Save(job); err != nil {
			s.mu.Unlock()
			return job, err
		}
	}
	s.jobs[id] = job
	s.mu.Unlock()
	scope := auditScopeFrom(ctx)
	go func(job contracts.EmployeeProvisionJob) {
		background, cancel := context.WithTimeout(withAuditScope(context.Background(), scope.actor, scope.correlationID), 15*time.Minute)
		defer cancel()
		var err error
		switch action {
		case "repair":
			err = s.Repair(background, username, nil)
		case "restart":
			err = s.Restart(background, username)
		case "rename-windows":
			err = s.RenameWindowsAccount(background, username, newName, nil)
		}
		job.Percent = 100
		job.Status = "succeeded"
		job.Step = "completed"
		if err != nil {
			job.Status = "failed"
			job.Step = "failed"
			job.ErrorCode = "MAINTENANCE_FAILED"
			job.ErrorMessage = err.Error()
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.Jobs != nil {
			if saveErr := s.Jobs.Save(job); saveErr != nil {
				log.Printf("persist employee maintenance result: %v", saveErr)
			}
		}
		s.jobs[id] = job
	}(job)
	return job, nil
}
