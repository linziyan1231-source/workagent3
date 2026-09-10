package modelgateway

import (
	"context"
	"net/http"
	"strings"
	"time"
	"workagent3/internal/contracts"
)

type dollarSink interface {
	SyncDollarBilling(context.Context, []contracts.DollarBudget, []contracts.BillingRate) error
	RecordDollarUsage(context.Context, string, string, float64) error
}

func (d *UsageDrainer) syncBilling(ctx context.Context) error {
	sink, ok := d.sink.(dollarSink)
	if !ok {
		return nil
	}
	if time.Since(d.billingUpdated) < 5*time.Second {
		return nil
	}
	var response struct {
		Keys []struct {
			ID     string     `json:"id"`
			Models []keyModel `json:"models"`
			Daily  float64    `json:"daily_limit_usd"`
			Weekly float64    `json:"weekly_limit_usd"`
			Usage  struct {
				Daily       float64 `json:"daily_usd"`
				Weekly      float64 `json:"weekly_usd"`
				DailyReset  string  `json:"daily_reset_at"`
				WeeklyReset string  `json:"weekly_reset_at"`
			} `json:"usage"`
		} `json:"keys"`
	}
	if err := d.client.json(ctx, http.MethodGet, "/keys", nil, &response); err != nil {
		return err
	}
	budgets := []contracts.DollarBudget{}
	rates := []contracts.BillingRate{}
	for _, key := range response.Keys {
		sid, found, err := d.sink.MapGatewayKey(ctx, key.ID)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		pool := "codex"
		if strings.HasSuffix(key.ID, "-kimi") {
			pool = "kimi"
		}
		budgets = append(budgets, contracts.DollarBudget{SID: sid, Pool: pool, DailyLimitUSD: key.Daily, WeeklyLimitUSD: key.Weekly, DailyUSD: key.Usage.Daily, WeeklyUSD: key.Usage.Weekly, DailyResetAt: key.Usage.DailyReset, WeeklyResetAt: key.Usage.WeeklyReset, UpdatedAt: time.Now().UTC()})
		for _, m := range key.Models {
			rate := contracts.BillingRate{SID: sid, Model: m.Alias, Pool: pool, Mode: m.BillingMode, Input: m.InputPricePerMillion, Output: m.OutputPricePerMillion, Cache: m.CacheReadPricePerMillion, PerCall: m.PerCallUSD}
			rates = append(rates, rate)
			if m.TargetModel != m.Alias {
				rate.Model = m.TargetModel
				rates = append(rates, rate)
			}
		}
	}
	if err := sink.SyncDollarBilling(ctx, budgets, rates); err != nil {
		return err
	}
	d.billingRates = rates
	d.billingUpdated = time.Now()
	return nil
}

func (d *UsageDrainer) recordCost(ctx context.Context, r contracts.GatewayUsageRecord) error {
	sink, ok := d.sink.(dollarSink)
	if !ok {
		return nil
	}
	for _, price := range d.billingRates {
		if price.SID != r.SID || (price.Model != r.Alias && price.Model != r.Model) {
			continue
		}
		usd := (float64(max(0, r.InputTokens-r.CachedTokens))*price.Input + float64(r.OutputTokens)*price.Output + float64(r.CachedTokens)*price.Cache) / 1000000
		if price.Mode == "per_call" {
			usd = price.PerCall
		}
		if r.Failed {
			usd = 0
		}
		return sink.RecordDollarUsage(ctx, r.RequestID, price.Pool, usd)
	}
	return nil
}
