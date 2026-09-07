package employeemanager

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/employee"
)

type blockedMaintenance struct{ entered, release chan struct{} }

func (p blockedMaintenance) StopInstalledRuntime(ctx context.Context, _ string) error {
	close(p.entered)
	select {
	case <-p.release:
		return ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p blockedMaintenance) StartInstalledRuntime(ctx context.Context, _ string) error {
	return ctx.Err()
}

func TestMaintenanceSurvivesRequestCancellationAndPersists(t *testing.T) {
	data, _ := openAuditFixtures(t)
	if _, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", "hash"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "jobs.db")
	jobs, err := OpenJobStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer jobs.Close()
	platform := blockedMaintenance{make(chan struct{}), make(chan struct{})}
	service := &Service{Jobs: jobs, Lifecycle: employee.Lifecycle{Users: data, Platform: platform}}
	ctx, cancel := context.WithCancel(t.Context())
	job, err := service.StartMaintenance(ctx, "restart", "alice", "")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-platform.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("worker did not start")
	}
	cancel()
	if _, err := service.StartMaintenance(t.Context(), "repair", "ALICE", ""); err == nil {
		t.Fatal("overlapping operation accepted")
	}
	close(platform.release)
	deadline := time.Now().Add(3 * time.Second)
	for {
		current, _ := service.ProvisionJob(t.Context(), job.ID)
		if current.Status != "running" {
			if current.Status != "succeeded" {
				t.Fatalf("request cancellation stopped worker: %+v", current)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	recovered := &Service{Jobs: jobs}
	if err := recovered.RestoreJobs(); err != nil {
		t.Fatal(err)
	}
	current, err := recovered.ProvisionJob(t.Context(), job.ID)
	if err != nil || current.Status != "succeeded" {
		t.Fatalf("completion not durable: %+v %v", current, err)
	}
}

func TestMaintenanceInterruptedStateSurvivesRepeatedRestarts(t *testing.T) {
	jobs, err := OpenJobStore(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer jobs.Close()
	if err := jobs.Save(contracts.EmployeeProvisionJob{ID: "interrupted", Username: "alice", Status: "running", Step: "repair"}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		service := &Service{Jobs: jobs}
		if err := service.RestoreJobs(); err != nil {
			t.Fatal(err)
		}
		job, err := service.ProvisionJob(t.Context(), "interrupted")
		if err != nil || job.Status != "failed" || job.ErrorCode != "MAINTENANCE_INTERRUPTED" {
			t.Fatalf("unsafe recovery: %+v %v", job, err)
		}
	}
}
