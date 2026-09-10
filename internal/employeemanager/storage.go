package employeemanager

import (
	"context"
	"errors"
	"workagent3/internal/audit"
	"workagent3/internal/contracts"
)

type StoragePlatform interface {
	StorageUsage(context.Context, string) (contracts.StorageUsage, error)
	SetStorageLimits(context.Context, string, contracts.StorageLimits) (contracts.StorageUsage, error)
}

func (s *Service) StorageUsage(ctx context.Context, sid string, limits *contracts.StorageLimits) (contracts.StorageUsage, error) {
	if s.Storage == nil {
		return contracts.StorageUsage{}, errors.New("storage quotas unavailable")
	}
	users, err := s.Users.ListManagedUsers(ctx)
	if err != nil {
		return contracts.StorageUsage{}, err
	}
	for _, user := range users {
		if user.SID != sid {
			continue
		}
		if limits != nil {
			value, err := s.Storage.SetStorageLimits(ctx, sid, *limits)
			s.record(ctx, audit.ActionEmployeeLimitsUpdate, user.Username, err, map[string]string{"scope": "storage"})
			return value, err
		}
		return s.Storage.StorageUsage(ctx, sid)
	}
	return contracts.StorageUsage{}, errors.New("employee not found")
}
