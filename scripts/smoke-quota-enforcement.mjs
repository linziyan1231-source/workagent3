import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "playwright";
import {
  baseURL,
  smokeUsername,
  json,
  uniqueName,
  withPage,
} from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("WORKAGENT_SMOKE_EVIDENCE_DIR is required");
await mkdir(evidence, { recursive: true });
const admin = await request.newContext({
  baseURL,
  extraHTTPHeaders: { Origin: baseURL },
});
const login = await admin.post("/api/auth/login", {
  data: {
    username: process.env.WORKAGENT_SMOKE_ADMIN_USERNAME || "admin",
    password: process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD,
  },
});
assert.equal(login.status(), 200);
const budgets = async () => {
  const response = await admin.get(
    `/api/portal/admin/quotas?username=${encodeURIComponent(smokeUsername)}`,
  );
  assert.equal(response.status(), 200);
  return (await response.json()).budgets;
};
const originals = await budgets();
const touched = new Set();
const adjust = async (id, mode, limit) => {
  touched.add(id);
  const response = await admin.post("/api/portal/admin/quotas", {
    data: { username: smokeUsername, modelId: id, mode, limitUnits: limit },
  });
  assert.equal(response.status(), 200);
};
const report = { checkedAt: new Date().toISOString(), engines: [] };

try {
  await withPage(async (page) => {
    const sessions = [];
    const presets = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const groups = await json(page, "/api/runtime/v1/model-options");
    const poll = async (load, accept, timeout = 90_000) => {
      const deadline = Date.now() + timeout;
      let value;
      do {
        value = await load();
        if (accept(value)) return value;
        await page.waitForTimeout(500);
      } while (Date.now() < deadline);
      throw new Error(`Timed out: ${JSON.stringify(value)}`);
    };
    try {
      const engines = process.env.WORKAGENT_SMOKE_ENGINES?.split(",") || [
        "codex",
        "kimi",
        "harness",
      ];
      assert(
        engines.length &&
          engines.every((engine) =>
            ["codex", "kimi", "harness"].includes(engine),
          ),
      );
      for (const engine of engines) {
        const group = groups.find((g) => g.engine === engine);
        assert.equal(group?.state, "ready", `${engine} models unavailable`);
        const model = group.models.find((m) => m.isDefault) || group.models[0];
        const pool =
          engine === "harness" ? "harness-default" : `${engine}-native`;
        const concrete = model.id.replace(/^kimi-code\//, "");
        let presetId;
        if (engine === "harness") {
          const preset = await json(page, "/api/runtime/v1/presets", {
            method: "POST",
            body: JSON.stringify({
              name: uniqueName("Harness 额度验收"),
              engine,
              modelId: "harness-default",
            }),
          });
          presetId = preset.id;
          presets.push(preset.id);
        }
        const session = await json(page, "/api/runtime/v1/sessions", {
          method: "POST",
          body: JSON.stringify({
            engine,
            title: uniqueName(`${engine}-额度验收`),
            workspace: "default",
            modelId: model.id,
            ...(presetId ? { presetId } : {}),
            thinkingEffort: "low",
            permissionMode: "read_only",
          }),
        });
        sessions.push(session.id);
        const path = `/api/runtime/v1/sessions/${session.id}/turns`;
        const beforeGateway = await json(page, "/api/quota/gateway-usage");
        const before = await budgets();
        assert(before.find((b) => b.modelId === pool)?.gatewayAccounting);
        await adjust(pool, "temporary", 0);
        await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
        const composer = page.getByLabel("继续对话", { exact: true });
        await composer.waitFor();
        const deniedResponse = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === path &&
            r.request().method() === "POST",
        );
        await composer.fill("Reply with QUOTA_MUST_NOT_RUN. Do not use tools.");
        await composer.press("Enter");
        const denied = await deniedResponse;
        assert.equal((await denied.json()).error, "quota_exceeded");
        await page
          .getByText("使用额度不足，请联系管理员调整额度，或等待下一周期。", {
            exact: false,
          })
          .first()
          .waitFor();
        await page.screenshot({
          path: join(evidence, `${engine}-quota-blocked.png`),
        });
        assert.equal(
          (await json(page, `/api/runtime/v1/sessions/${session.id}/messages`))
            .length,
          0,
        );
        const stillGateway = await json(page, "/api/quota/gateway-usage");
        assert.equal(
          stillGateway.dailyTokens,
          beforeGateway.dailyTokens,
          "blocked input reached upstream",
        );

        // Concrete-model caps must also apply even when the engine pool has room.
        const original = originals.find((b) => b.modelId === pool);
        if (engine === "codex") {
          await page.getByRole("button", { name: "设置", exact: true }).click();
          const quotaRow = page
            .locator(".workagent-quota-row")
            .filter({ hasText: "Codex" });
          await quotaRow.getByText("0%", { exact: true }).waitFor();
          await page.screenshot({
            path: join(evidence, "employee-zero-quota.png"),
          });
          await adjust(pool, "permanent", original.baseLimitUnits);
          const current = (await budgets()).find((b) => b.modelId === pool);
          const percent = Math.round(
            (Math.max(
              current.limitUnits -
                current.consumedUnits -
                current.reservedUnits,
              0,
            ) /
              current.limitUnits) *
              100,
          );
          assert(percent > 0, "test budget needs room to verify live refresh");
          await quotaRow.getByText(`${percent}%`, { exact: true }).waitFor();
          report.employeeZeroAndLiveRefresh = true;
          await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
        }
        await adjust(pool, "permanent", original.baseLimitUnits);
        await adjust(concrete, "temporary", 0);
        const modelDenied = await page.request.post(baseURL + path, {
          data: { content: "Blocked by model budget." },
          headers: { Origin: baseURL },
        });
        assert.equal((await modelDenied.json()).error, "quota_exceeded");
        await adjust(concrete, "restore", 0);

        const beforeModel = before.find(
          (b) => b.modelId === concrete,
        ).consumedUnits;
        const accepted = await page.request.post(baseURL + path, {
          data: {
            content: `Reply with exactly QUOTA_${engine.toUpperCase()}_OK. Do not use tools or modify files.`,
          },
          headers: { Origin: baseURL },
        });
        assert.equal(accepted.status(), 202, await accepted.text());
        await poll(
          () => json(page, `/api/runtime/v1/sessions/${session.id}`),
          (s) => s.lastTurn?.status === "completed",
        );
        const after = await poll(
          budgets,
          (rows) =>
            rows.find((b) => b.modelId === concrete).consumedUnits >
              beforeModel &&
            rows.find((b) => b.modelId === concrete).reservedUnits === 0,
        );
        const afterGateway = await json(page, "/api/quota/gateway-usage");
        const charged =
          after.find((b) => b.modelId === concrete).consumedUnits - beforeModel;
        assert.equal(
          charged,
          afterGateway.dailyTokens - beforeGateway.dailyTokens,
          "Portal and gateway consumption diverged",
        );
        assert(charged > 0);
        await page.reload();
        await page
          .getByText(`QUOTA_${engine.toUpperCase()}_OK`, { exact: false })
          .last()
          .waitFor();
        await page.screenshot({
          path: join(evidence, `${engine}-quota-restored.png`),
        });
        const exhausted = after.find((b) => b.modelId === pool).consumedUnits;
        await adjust(pool, "temporary", exhausted);
        const nextDenied = await page.request.post(baseURL + path, {
          data: { content: "Must be blocked after spending." },
          headers: { Origin: baseURL },
        });
        assert.equal((await nextDenied.json()).error, "quota_exceeded");
        await adjust(pool, "permanent", original.baseLimitUnits);
        if (original.temporary)
          await adjust(pool, "temporary", original.limitUnits);
        report.engines.push({
          engine,
          model: model.id,
          chargedTokens: charged,
          poolZeroBlocked: true,
          modelZeroBlocked: true,
          restoredChatCompleted: true,
          realUsageExhaustionBlocked: true,
        });
        console.log(JSON.stringify(report.engines.at(-1)));
      }
      assert.deepEqual(errors, []);
    } finally {
      for (const id of sessions) {
        await page.request
          .post(`${baseURL}/api/runtime/v1/sessions/${id}/cancel`, {
            headers: { Origin: baseURL },
          })
          .catch(() => undefined);
        await json(page, `/api/runtime/v1/sessions/${id}`, {
          method: "DELETE",
        });
      }
      for (const id of presets) {
        await json(page, `/api/runtime/v1/presets/${id}`, {
          method: "DELETE",
        });
      }
    }
  });
} finally {
  for (const id of touched) {
    const original = originals.find((b) => b.modelId === id);
    if (!original) continue;
    await adjust(id, "permanent", original.baseLimitUnits);
    if (original.temporary) await adjust(id, "temporary", original.limitUnits);
  }
  report.budgetsRestored = true;
  await writeFile(
    join(evidence, "quota-enforcement.json"),
    JSON.stringify(report, null, 2),
  );
  await admin.dispose();
}
console.log(
  "Live quota admission, real usage accounting, and recovery passed for tested engines",
);
