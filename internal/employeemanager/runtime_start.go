package employeemanager

import (
	"context"
	"errors"
)

func (s *Service) EnsureRuntime(ctx context.Context, sid string) error {
	user, err := s.Users.UserBySID(ctx, sid)
	if err != nil {
		return err
	}
	if !user.Disabled && !user.Offboarded {
		return s.Lifecycle.Platform.StartInstalledRuntime(ctx, sid)
	}
	return errors.New("employee unavailable")
}
