import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  login,
  requireSmokeEnvironment,
  openSettingsSection,
  json,
} from "./smoke-dsh-helpers.mjs";

requireSmokeEnvironment();
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("Evidence directory required");
await mkdir(evidence, { recursive: true });
const candidate = process.env.WORKAGENT_SMOKE_CAPABILITY_CLIENT;
const fixture = process.env.WORKAGENT_SMOKE_CAPABILITY_FIXTURE === "1";
const report = { status: "running", fixture, checks: [], errors: [] };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  if (candidate) {
    const body = await readFile(candidate, "utf8");
    await page.route("**/plugins/@workagent/dsh-client/client.js*", (route) =>
      route.fulfill({ contentType: "text/javascript", body }),
    );
  }
  let server = {
    id: "fixture-global-mcp",
    name: "全局 MCP 验证",
    source: "user",
    enabled: true,
    health: "healthy",
    oauthState: "none",
    transport: {
      kind: "stdio",
      command: "fixture.exe",
      globalSource: "codex/config:fixture",
    },
  };
  let skill = {
    id: "fixture-global-skill",
    name: "全局技能验证",
    source: "user",
    enabled: true,
    health: "ready",
    referenceDirectory: "fixture/source",
    compatibleEngines: ["codex", "kimi", "harness"],
  };
  let syncCount = 0;
  if (fixture) {
    await page.route("**/api/runtime/v1/presets", async (route) => {
      const response = await route.fetch();
      const presets = await response.json();
      const codex = presets.find((preset) => preset.id === "builtin-codex");
      return route.fulfill({
        json: [
          ...presets.filter((preset) => preset.id !== "builtin-puxin-butler"),
          {
            ...codex,
            id: "builtin-puxin-butler",
            name: "AI管家",
            enabled: true,
          },
        ],
      });
    });
    await page.route("**/api/runtime/v1/capability-sync/*", (route) => {
      if (route.request().method() === "POST") syncCount++;
      return route.fulfill({
        json: {
          items: [],
          scope: "employee-global",
          appliesTo: "new-sessions",
        },
      });
    });
    for (const [path, get, set] of [
      ["mcp-servers", () => server, (value) => (server = value)],
      ["skills", () => skill, (value) => (skill = value)],
    ]) {
      await page.route(`**/api/runtime/v1/${path}*`, (route) =>
        route.fulfill({ json: [get()] }),
      );
      await page.route(`**/api/runtime/v1/${path}/*`, (route) => {
        assert.equal(route.request().method(), "PATCH");
        set({ ...get(), ...route.request().postDataJSON() });
        return route.fulfill({ json: get() });
      });
    }
  }
  await login(page);
  const butler = page.getByRole("radio", { name: "AI管家", exact: true });
  await butler.waitFor();
  await butler.click();
  assert.equal(await butler.getAttribute("aria-checked"), "true");
  assert.equal(
    await page
      .getByRole("button", { name: /找.*管家帮忙|已选择.*管家/ })
      .count(),
    0,
  );
  await page.screenshot({ path: join(evidence, "butler-entry.png") });
  report.checks.push(
    "AI管家 remains available in the agent selector without an extra shortcut",
  );
  let section = await openSettingsSection(page, "MCP 服务");
  await section
    .getByRole("button", { name: "检查新安装", exact: true })
    .waitFor();
  await section.getByText(/项目安装仍留在项目/).waitFor();
  if (fixture) {
    const card = section.locator("article", { hasText: server.name });
    await card.getByText(/Codex 全局安装/).waitFor();
    await card.getByRole("button", { name: "停用", exact: true }).click();
    await card.getByRole("button", { name: "启用", exact: true }).waitFor();
    await section
      .getByRole("button", { name: "检查新安装", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.body.innerText.includes("正在同步…"),
    );
    assert.equal(syncCount, 1);
    assert.equal(server.enabled, false);
    report.checks.push(
      "MCP origin, toggle, immediate sync and disabled-state retention",
    );
  } else {
    const status = await json(page, "/api/runtime/v1/capability-sync/status");
    assert.equal(status.scope, "employee-global");
    assert.equal(status.error, "");
    report.checks.push(
      "Authenticated production MCP settings and employee-global sync status",
    );
  }
  await page.screenshot({
    path: join(evidence, "mcp-settings.png"),
    fullPage: true,
  });
  await page.reload();
  section = await openSettingsSection(page, "技能");
  await section
    .getByRole("button", { name: "检查新安装", exact: true })
    .waitFor();
  if (fixture) {
    const card = section.locator("article", { hasText: skill.name });
    await card.getByText(/全局目录共享/).waitFor();
    await card.getByRole("button", { name: "停用", exact: true }).click();
    await card.getByRole("button", { name: "启用", exact: true }).waitFor();
    assert.equal(skill.enabled, false);
  }
  await page.screenshot({
    path: join(evidence, "skill-settings.png"),
    fullPage: true,
  });
  report.checks.push("Skill settings discovery and enable/disable controls");
  await page.setViewportSize({ width: 390, height: 844 });
  await section
    .getByRole("button", { name: "检查新安装", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "skill-settings-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} finally {
  await browser.close();
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report, null, 2));
