package portal

import (
	"context"
	"errors"
	"workagent3/internal/marketplace"
	"workagent3/internal/skillruntime"
	"workagent3/internal/store"
)

// Retain the historical market in the new version catalog and adopt existing installations.
func (s *Server) importLegacyMarket(ctx context.Context, user store.User) error {
	if s.modules.SkillMarket == nil {
		return nil
	}
	entries, err := s.modules.SkillMarket.ListApproved(ctx, user.Username)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	s.modules.Marketplace.InstallMu.Lock()
	defer s.modules.Marketplace.InstallMu.Unlock()
	var installed []skillruntime.Entry
	endpoint, err := s.runtimes.Resolve(ctx, user.SID)
	if err != nil {
		return errors.New("employee_runtime_pending")
	}
	if err = (marketRuntime{endpoint: endpoint}).call(ctx, "GET", "/v1/skills", nil, &installed); err != nil {
		return err
	}
	for _, legacy := range entries {
		id := "legacy-" + legacy.ID
		e, _, err := s.modules.Marketplace.Snapshot(ctx, id)
		if errors.Is(err, marketplace.ErrNotFound) {
			p, err := s.modules.SkillMarket.ApprovedPackage(ctx, legacy.ID)
			if err != nil {
				return err
			}
			e = marketplace.Entry{ID: id, Kind: "skill", Name: legacy.Name, Description: legacy.Description, Version: legacy.Version, Publisher: legacy.Publisher.Username, ReleaseNotes: "历史市场版本"}
			b := marketplace.Bundle{Skills: []marketplace.Skill{{ID: legacy.ID, Name: p.Name, Description: p.Description, Version: p.Version, Archive: p.Archive}}, MCP: []marketplace.Connector{}}
			if err = s.modules.Marketplace.Publish(ctx, e, b); err != nil {
				return err
			}
			e, _, err = s.modules.Marketplace.Snapshot(ctx, id)
			if err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		for _, skill := range installed {
			if skill.ID != legacy.ID || skill.Source != "market" {
				continue
			}
			state, err := s.modules.Marketplace.Installation(ctx, user.SID, id)
			if err != nil {
				return err
			}
			if state.Complete {
				continue
			}
			state.Skills[legacy.ID] = skill.ID
			state.Complete = true
			if err = s.modules.Marketplace.SaveInstallation(ctx, user.SID, id, state); err != nil {
				return err
			}
			if _, _, err = s.modules.Marketplace.Selection(ctx, user.SID, e.SeriesID); !e.Revoked && errors.Is(err, marketplace.ErrNotFound) {
				if err = s.modules.Marketplace.Select(ctx, user.SID, e); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
