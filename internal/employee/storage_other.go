//go:build !windows

package employee

import (
	"context"
	"errors"
	"workagent3/internal/contracts"
)

func (*WindowsPlatform) StorageUsage(context.Context, string) (contracts.StorageUsage, error) {
	return contracts.StorageUsage{}, errors.New("FSRM requires Windows Server")
}
func (*WindowsPlatform) SetStorageLimits(context.Context, string, contracts.StorageLimits) (contracts.StorageUsage, error) {
	return contracts.StorageUsage{}, errors.New("FSRM requires Windows Server")
}
