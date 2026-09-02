package main

import (
	"context"
	"fmt"
	"strings"

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
// bootstrap, so it also repairs a catalog that never bootstrapped), grants
// the harness/codex/kimi internal models plus every configured upstream model
// (shared-run settlement and the native providers reserve against the real
// model IDs like gpt-5.6-sol, so those need their own catalog entry,
// authorization, and budget), and plants daily token budgets converted from
// the configured gateway USD caps. Every authorization/budget write is
// insert-if-absent, so provision retries and repair replays never overwrite
// later administrator adjustments. The internal schema holds one budget row
// per (SID, model), so the daily period is seeded; the weekly USD cap stays
// enforced by the gateway key itself.
func (s entitlementSeeder) SeedDefaults(ctx context.Context, sid string) error {
	if err := modelaccess.SeedCatalog(ctx, s.models, s.config.CodexModel); err != nil {
		return err
	}
	codexTokens := usdToTokens(s.config.CodexDailyUSD)
	kimiTokens := usdToTokens(s.config.KimiDailyUSD)
	for _, modelID := range []string{modelaccess.HarnessDefaultModelID, modelaccess.CodexNativeModelID, modelaccess.KimiNativeModelID} {
		if err := s.models.EnsureAuthorization(ctx, sid, modelID, "provision_default"); err != nil {
			return fmt.Errorf("seed model authorization %s: %w", modelID, err)
		}
	}
	budgets := []quota.Budget{
		{SID: sid, ModelID: modelaccess.HarnessDefaultModelID, Period: quota.Daily, LimitUnits: codexTokens},
		{SID: sid, ModelID: modelaccess.CodexNativeModelID, Period: quota.Daily, LimitUnits: codexTokens},
		{SID: sid, ModelID: modelaccess.KimiNativeModelID, Period: quota.Daily, LimitUnits: kimiTokens},
	}
	for _, budget := range budgets {
		if err := s.quotas.EnsureBudget(ctx, budget); err != nil {
			return fmt.Errorf("seed quota budget %s: %w", budget.ModelID, err)
		}
	}
	// Real upstream model IDs. The configured primary models are included
	// explicitly in case the lists omit them; duplicates converge harmlessly
	// because every write below is an upsert (catalog) or insert-if-absent
	// (authorization, budget).
	for _, modelID := range append([]string{s.config.CodexModel}, s.config.CodexModels...) {
		if err := s.seedUpstreamModel(ctx, sid, "codex", modelID, codexTokens); err != nil {
			return err
		}
	}
	for _, modelID := range append([]string{s.config.KimiModel}, s.config.KimiModels...) {
		if err := s.seedUpstreamModel(ctx, sid, "kimi", modelID, kimiTokens); err != nil {
			return err
		}
	}
	return nil
}

// seedUpstreamModel seeds one configured upstream model with the same
// per-provider daily token allowance as the internal logical entries.
func (s entitlementSeeder) seedUpstreamModel(ctx context.Context, sid, providerID, modelID string, tokens int64) error {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return nil
	}
	if err := s.models.UpsertModel(ctx, modelaccess.Model{
		ID: modelID, ProviderID: providerID, DisplayName: modelID,
		Aliases: []string{}, ContextWindow: 128000, Health: modelaccess.Unknown,
	}); err != nil {
		return fmt.Errorf("seed model %s: %w", modelID, err)
	}
	if err := s.models.EnsureAuthorization(ctx, sid, modelID, "provision_default"); err != nil {
		return fmt.Errorf("seed model authorization %s: %w", modelID, err)
	}
	if err := s.quotas.EnsureBudget(ctx, quota.Budget{SID: sid, ModelID: modelID, Period: quota.Daily, LimitUnits: tokens}); err != nil {
		return fmt.Errorf("seed quota budget %s: %w", modelID, err)
	}
	return nil
}
