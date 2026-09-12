package skillruntime

import (
	"context"
	"errors"
)

func (s *Store) checkMarketRevocation(ctx context.Context, id string) error {
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM revoked_market_skills WHERE id=?`, id).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return errors.New("market_skill_revoked")
	}
	return nil
}
func (s *Store) RevokeMarket(ctx context.Context, id string, remove bool) error {
	entry, err := s.Get(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if entry.Source != "market" {
		return errors.New("market_skill_source_required")
	}
	if _, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO revoked_market_skills(id) VALUES(?)`, id); err != nil {
		return err
	}
	if _, err = s.SetEnabled(ctx, id, false); err != nil {
		return err
	}
	if remove {
		return s.Remove(ctx, id)
	}
	return nil
}
