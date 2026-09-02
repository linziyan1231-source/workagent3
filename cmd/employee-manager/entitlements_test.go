package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/modelaccess"
	"workagent3/internal/modelgateway"
	"workagent3/internal/quota"
)

func openSeeder(t *testing.T, config modelgateway.Config) (entitlementSeeder, string) {
	t.Helper()
	root := t.TempDir()
	models, err := modelaccess.Open(filepath.Join(root, "model-access.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { models.Close() })
	quotaPath := filepath.Join(root, "quota.db")
	quotas, err := quota.OpenRecorder(quotaPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { quotas.Close() })
	return entitlementSeeder{models: models, quotas: quotas, config: config}, quotaPath
}

func TestEntitlementSeederGrantsInternalModelsAndBudgets(t *testing.T) {
	seeder, _ := openSeeder(t, modelgateway.Config{
		CodexModel: "gpt-5.6-sol", CodexModels: []string{"gpt-5.6-luna", "gpt-5.6-sol"}, CodexDailyUSD: 40, CodexWeeklyUSD: 80,
		KimiModel: "kimi-k3", KimiModels: []string{"kimi-for-coding", "kimi-k3"}, KimiDailyUSD: 10, KimiWeeklyUSD: 20,
	})
	ctx := context.Background()
	sid := "S-1-5-21-1000"
	if err := seeder.SeedDefaults(ctx, sid); err != nil {
		t.Fatal(err)
	}
	for _, modelID := range []string{modelaccess.HarnessDefaultModelID, modelaccess.CodexNativeModelID, modelaccess.KimiNativeModelID} {
		authorized, err := seeder.models.Authorized(ctx, sid, modelID)
		if err != nil || !authorized {
			t.Fatalf("model %s not authorized: authorized=%t err=%v", modelID, authorized, err)
		}
	}
	codexTokens := usdToTokens(40)
	kimiTokens := usdToTokens(10)
	for modelID, expected := range map[string]int64{
		modelaccess.HarnessDefaultModelID: codexTokens,
		modelaccess.CodexNativeModelID:    codexTokens,
		modelaccess.KimiNativeModelID:     kimiTokens,
	} {
		usage, err := seeder.quotas.Usage(ctx, sid, modelID, time.Time{})
		if err != nil {
			t.Fatalf("budget %s missing: %v", modelID, err)
		}
		if usage.Period != string(quota.Daily) || usage.LimitUnits != expected {
			t.Fatalf("budget %s = %#v, expected daily %d", modelID, usage, expected)
		}
	}
	// Configured upstream model IDs (shared-run settlement and native
	// providers reserve against these directly) are authorized and budgeted
	// with the same per-provider allowance.
	for modelID, expected := range map[string]int64{
		"gpt-5.6-sol":     codexTokens,
		"gpt-5.6-luna":    codexTokens,
		"kimi-k3":         kimiTokens,
		"kimi-for-coding": kimiTokens,
	} {
		authorized, err := seeder.models.Authorized(ctx, sid, modelID)
		if err != nil || !authorized {
			t.Fatalf("upstream model %s not authorized: authorized=%t err=%v", modelID, authorized, err)
		}
		usage, err := seeder.quotas.Usage(ctx, sid, modelID, time.Time{})
		if err != nil {
			t.Fatalf("upstream budget %s missing: %v", modelID, err)
		}
		if usage.Period != string(quota.Daily) || usage.LimitUnits != expected {
			t.Fatalf("upstream budget %s = %#v, expected daily %d", modelID, usage, expected)
		}
	}
}

// TestEntitlementSeederAllowsReserveByUpstreamModelID proves the acceptance
// failure is gone: a reserving quota store (as the Portal holds it) accepts a
// reservation pinned to the real configured model ID after seeding.
func TestEntitlementSeederAllowsReserveByUpstreamModelID(t *testing.T) {
	seeder, quotaPath := openSeeder(t, modelgateway.Config{
		CodexModel: "gpt-5.6-sol", CodexModels: []string{"gpt-5.6-luna", "gpt-5.6-sol"}, CodexDailyUSD: 40, CodexWeeklyUSD: 80,
		KimiModel: "kimi-k3", KimiModels: []string{"kimi-for-coding", "kimi-k3"}, KimiDailyUSD: 10, KimiWeeklyUSD: 20,
	})
	ctx := context.Background()
	sid := "S-1-5-21-1000"
	if err := seeder.SeedDefaults(ctx, sid); err != nil {
		t.Fatal(err)
	}
	reserving, err := quota.Open(quotaPath, seeder.models)
	if err != nil {
		t.Fatal(err)
	}
	defer reserving.Close()
	for _, modelID := range []string{"gpt-5.6-sol", "kimi-k3"} {
		if _, err := reserving.Reserve(ctx, quota.ReserveRequest{RunID: "run-" + modelID, SID: sid, ModelID: modelID, EstimatedUnits: 100}); err != nil {
			t.Fatalf("reserve by upstream model %s denied after seeding: %v", modelID, err)
		}
	}
}

func TestEntitlementSeederReplayPreservesAdministratorAdjustments(t *testing.T) {
	seeder, _ := openSeeder(t, modelgateway.Config{
		CodexModel: "gpt-5.6-sol", CodexDailyUSD: 40, CodexWeeklyUSD: 80,
		KimiModel: "kimi-k3", KimiDailyUSD: 10, KimiWeeklyUSD: 20,
	})
	ctx := context.Background()
	sid := "S-1-5-21-1000"
	if err := seeder.SeedDefaults(ctx, sid); err != nil {
		t.Fatal(err)
	}
	// Administrator adjusts one authorization and one budget afterwards.
	if err := seeder.models.SetAuthorization(ctx, sid, modelaccess.KimiNativeModelID, false, "admin_revoke"); err != nil {
		t.Fatal(err)
	}
	if err := seeder.quotas.SetBudget(ctx, quota.Budget{SID: sid, ModelID: modelaccess.CodexNativeModelID, Period: quota.Daily, LimitUnits: 123}); err != nil {
		t.Fatal(err)
	}
	// A repair replay must not clobber either adjustment, but must restore a
	// missing authorization (simulating a lost row) for another model.
	if err := seeder.SeedDefaults(ctx, sid); err != nil {
		t.Fatal(err)
	}
	authorized, err := seeder.models.Authorized(ctx, sid, modelaccess.KimiNativeModelID)
	if err != nil || authorized {
		t.Fatalf("replay overwrote administrator revocation: authorized=%t err=%v", authorized, err)
	}
	usage, err := seeder.quotas.Usage(ctx, sid, modelaccess.CodexNativeModelID, time.Time{})
	if err != nil || usage.LimitUnits != 123 {
		t.Fatalf("replay overwrote administrator budget: usage=%#v err=%v", usage, err)
	}
	authorized, err = seeder.models.Authorized(ctx, sid, modelaccess.HarnessDefaultModelID)
	if err != nil || !authorized {
		t.Fatalf("replay lost the harness authorization: authorized=%t err=%v", authorized, err)
	}
}

func TestRequireTaskControlIdentity(t *testing.T) {
	original := currentProcessSID
	t.Cleanup(func() { currentProcessSID = original })
	currentProcessSID = func() (string, error) { return "S-1-5-21-500-500", nil }
	err := requireTaskControlIdentity("enable")
	if err == nil || !strings.Contains(err.Error(), "loopback Employee Manager service") {
		t.Fatalf("interactive identity was accepted: %v", err)
	}
	// Non task-controlling actions never require SYSTEM.
	if err := requireTaskControlIdentity("reset-password"); err != nil {
		t.Fatalf("password reset requires no task control: %v", err)
	}
	currentProcessSID = func() (string, error) { return "S-1-5-18", nil }
	if err := requireTaskControlIdentity("enable"); err != nil {
		t.Fatalf("SYSTEM identity was rejected: %v", err)
	}
	currentProcessSID = func() (string, error) { return "", errors.New("token unavailable") }
	if err := requireTaskControlIdentity("repair"); err == nil {
		t.Fatal("identity lookup failure was accepted")
	}
}

func TestTaskControlActionsCoverEveryScheduledTaskMutation(t *testing.T) {
	// Any CLI action that registers, starts, stops, or unregisters the
	// SDDL-isolated WorkAgent3-<SID> task must be gated; the set mirrors the
	// lifecycle flows in internal/employee.
	for _, action := range []string{"add", "enable", "disable", "repair", "rename-windows", "set-limits", "offboard-retain", "offboard-delete"} {
		if !taskControlActions[action] {
			t.Fatalf("action %s is not gated", action)
		}
	}
	for _, action := range []string{"reset-password", "grant-admin", "revoke-admin"} {
		if taskControlActions[action] {
			t.Fatalf("action %s must not be gated", action)
		}
	}
}
