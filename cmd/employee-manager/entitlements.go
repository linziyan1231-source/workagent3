package main

import (
	"context"
	"fmt"

	"workagent3/internal/modelaccess"
	"workagent3/internal/modelgateway"
	"workagent3/internal/quota"
)

// assumedBlendedUSDPerMillionTokens converts the CLIProxyAPI USD caps into the
// internal quota unit (tokens). The authoritative day/week USD limits are
// enforced by CLIProxyAPI on the managed key itself; the internal quota layer
// is defense-in-depth accounting denominated in tokens, so the conversion uses
// a conservative blended input+output price of $5 per million tokens
// (GPT-5-class list pricing lands between $1.25/M input and $10/M output).
// Underestimating cheap-provider tokens only makes the internal cap bite
// earlier than the gateway's USD cap, never looser.
const assumedBlendedUSDPerMillionTokens = 5.0

func usdToTokens(usd float64) int64 {
	return int64(usd * 1_000_000 / assumedBlendedUSDPerMillionTokens)
}

// entitlementSeeder implements employee.EntitlementSeeder over the shared
// model-access and quota databases (the same files the Portal serves).
type entitlementSeeder struct {
	models *modelaccess.Store
	quotas *quota.Store
	config modelgateway.Config
}

// SeedDefaults makes a provisioned employee usable without manual database
// inserts: it seeds the internal model catalog (shared with the Portal
// bootstrap, so it also repairs a catalog that never bootstrapped), grants the
// harness/codex/kimi internal models, and plants daily token budgets converted
// from the configured gateway USD caps. Every write is insert-if-absent, so
// provision retries and repair replays never overwrite later administrator
// adjustments. The internal schema holds one budget row per (SID, model), so
// the daily period is seeded; the weekly USD cap stays enforced by the gateway
// key itself.
func (s entitlementSeeder) SeedDefaults(ctx context.Context, sid string) error {
	if err := modelaccess.SeedCatalog(ctx, s.models, s.config.CodexModel); err != nil {
		return err
	}
	for _, modelID := range []string{modelaccess.HarnessDefaultModelID, modelaccess.CodexNativeModelID, modelaccess.KimiNativeModelID} {
		if err := s.models.EnsureAuthorization(ctx, sid, modelID, "provision_default"); err != nil {
			return fmt.Errorf("seed model authorization %s: %w", modelID, err)
		}
	}
	budgets := []quota.Budget{
		{SID: sid, ModelID: modelaccess.HarnessDefaultModelID, Period: quota.Daily, LimitUnits: usdToTokens(s.config.CodexDailyUSD)},
		{SID: sid, ModelID: modelaccess.CodexNativeModelID, Period: quota.Daily, LimitUnits: usdToTokens(s.config.CodexDailyUSD)},
		{SID: sid, ModelID: modelaccess.KimiNativeModelID, Period: quota.Daily, LimitUnits: usdToTokens(s.config.KimiDailyUSD)},
	}
	for _, budget := range budgets {
		if err := s.quotas.EnsureBudget(ctx, budget); err != nil {
			return fmt.Errorf("seed quota budget %s: %w", budget.ModelID, err)
		}
	}
	return nil
}
