import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { baseURL, withPage, json, uniqueName } from "./smoke-dsh-helpers.mjs";

const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (output) await mkdir(output, { recursive: true });
await withPage(async (page) => {
  const report = {};
  const screenshot = async (name, target = page) => {
    if (output)
      await target.screenshot({
        path: `${output}/${name}.png`,
        fullPage: true,
      });
  };
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${baseURL}/admin/accounts`);
  await page
    .getByRole("heading", { name: "账户与额度", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "展开管理侧栏" }).waitFor();
  await page.locator(".admin-account-budgets progress").first().waitFor();
  assert.equal(
    await page.locator(".admin-quota-overview > .admin-card").count(),
    3,
  );
  const budgets = await json(page, "/api/portal/admin/users");
  assert(
    budgets.users.every((u) => u.budgets.length >= 3 && !u.quota_unavailable),
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  await screenshot("admin-quota-overview-collapsed");
  await page.getByRole("button", { name: "展开管理侧栏" }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "折叠管理侧栏" })
      .getAttribute("aria-expanded"),
    "true",
  );
  await page.getByRole("button", { name: "折叠管理侧栏" }).click();
  await page.reload();
  await page.getByRole("button", { name: "展开管理侧栏" }).waitFor();
  report.admin = {
    defaultCollapsed: true,
    persists: true,
    overview: true,
    accountsWithBudgets: budgets.users.length,
  };
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page
      .locator(".admin-sidebar")
      .evaluate((node) => getComputedStyle(node).position),
    "fixed",
  );
  assert.equal(
    await page
      .locator(".admin-accounts-table td:nth-child(3)")
      .first()
      .evaluate((node) => getComputedStyle(node).display),
    "table-cell",
  );
  assert((await page.locator(".admin-main").boundingBox()).y < 20);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await screenshot("admin-mobile-collapsed");
  await page.setViewportSize({ width: 1600, height: 1000 });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${baseURL}/?frontend=dsh`);
  const logout = page.getByRole("button", { name: "退出登录", exact: true });
  await logout.hover();
  const colors = await logout.evaluate((node) => ({
    text: getComputedStyle(node).color,
    background: getComputedStyle(node).backgroundColor,
  }));
  assert.notEqual(colors.background, "rgb(235, 238, 243)");
  assert.notEqual(colors.background, "rgb(255, 255, 255)");
  assert.notEqual(colors.text, colors.background);
  await screenshot("logout-dark-hover");
  report.logout = colors;

  const cleanup = [];
  const entries = [];
  let receiverContext;
  const call = (target, path, body, method = "POST") =>
    json(target, path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const runtime = "/api/runtime/v1";
  const market = "/api/portal/marketplace";
  const seedID = process.env.WORKAGENT_SMOKE_MARKET_SEED_ID;
  assert(
    seedID,
    "WORKAGENT_SMOKE_MARKET_SEED_ID is required (see scripts/fixtures/marketplace)",
  );
  try {
    const seed = await call(page, `${market}/install`, { id: seedID });
    const skillID = Object.values(seed.installation.skills)[0];
    cleanup.push([page, `${runtime}/skills/${skillID}`]);
    const mcpName = uniqueName("市场验收连接");
    const mcp = await call(page, `${runtime}/mcp-servers`, {
      name: mcpName,
      description: "验收配置，不发起外部请求",
      source: "user",
      enabled: true,
      transport: {
        kind: "http",
        url: "https://example.com/mcp",
        headerCredentialIds: {},
        environmentCredentialIds: {},
      },
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "none",
    });
    cleanup.push([page, `${runtime}/mcp-servers/${mcp.id}`]);
    const assistantName = uniqueName("市场验收助手");
    const assistant = await call(page, `${runtime}/presets`, {
      name: assistantName,
      description: "验证助手、技能与 MCP 一起获取",
      engine: "harness",
      modelId: null,
      enabled: false,
      systemPrompt: "Use the bundled writing skill.",
      workspacePolicy: "optional",
      skillIds: [],
      mcpServerIds: [],
      toolAllowlist: [],
      approvalPolicy: "on_risk",
    });
    cleanup.push([page, `${runtime}/presets/${assistant.id}`]);

    await page.goto(`${baseURL}/?frontend=dsh&workagent=assistants`);
    const editor = page.locator('[data-workagent-section="助手"]');
    await editor
      .locator("article")
      .filter({ hasText: assistantName })
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    const skills = editor.getByRole("group", { name: "技能", exact: true });
    await skills.locator("summary").click();
    await skills.getByRole("searchbox").fill("smoke-market-writing");
    await skills.getByRole("checkbox").check();
    const mcps = editor.getByRole("group", { name: "MCP 服务", exact: true });
    await mcps.locator("summary").click();
    await mcps.getByRole("searchbox").fill(mcpName);
    await mcps.getByRole("checkbox").check();
    await screenshot("assistant-search-select");
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        r.url().endsWith(`/presets/${assistant.id}`),
    );
    await editor.getByRole("button", { name: "保存助手", exact: true }).click();
    assert.equal((await saved).status(), 200);
    const configured = (await json(page, `${runtime}/presets`)).find(
      (p) => p.id === assistant.id,
    );
    assert.deepEqual(configured.skillIds, [skillID]);
    assert.deepEqual(configured.mcpServerIds, [mcp.id]);
    assert.equal(configured.description, assistant.description);
    assert.equal(configured.enabled, false);
    report.assistantPicker = {
      searchable: true,
      skillBinding: true,
      mcpBinding: true,
      otherFieldsPreserved: true,
    };

    await page.goto(`${baseURL}/?frontend=dsh&workagent=marketplace`);
    const section = page.locator('[data-workagent-section="市场"]');
    await section
      .getByRole("button", { name: "发布到市场", exact: true })
      .click();
    const publish = section.locator(".workagent-market-publish");
    await publish.getByLabel("发布类型").selectOption("assistant");
    await publish.getByLabel("搜索已安装内容").fill(assistantName);
    await publish.getByLabel("发布内容").selectOption(assistant.id);
    await publish.getByLabel("市场名称").fill(assistantName);
    await screenshot("market-publish-assistant");
    const published = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && new URL(r.url()).pathname === market,
    );
    await publish.getByRole("button", { name: "发布", exact: true }).click();
    const publication = await published;
    assert.equal(publication.status(), 201);
    const entry = (await publication.json()).entry;
    entries.push(entry.id);
    for (const [kind, sourceId, name] of [
      ["skill", skillID, "验收技能发布"],
      ["mcp", mcp.id, "验收 MCP 发布"],
    ]) {
      const value = await call(page, market, {
        kind,
        sourceId,
        name: uniqueName(name),
        description: "验收后下架",
        version: "1.0.0",
      });
      entries.push(value.entry.id);
    }

    receiverContext = await page
      .context()
      .browser()
      .newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: "dark",
      });
    const receiver = await receiverContext.newPage();
    const login = await receiver.request.post(`${baseURL}/api/auth/login`, {
      data: {
        username: process.env.WORKAGENT_SMOKE_SECOND_USERNAME,
        password: process.env.WORKAGENT_SMOKE_SECOND_PASSWORD,
      },
      headers: { Origin: baseURL },
    });
    assert(login.ok());
    await receiver.goto(`${baseURL}/?frontend=dsh&workagent=marketplace`);
    const receiverMarket = receiver.locator('[data-workagent-section="市场"]');
    await receiverMarket
      .getByRole("searchbox", { name: "搜索市场" })
      .fill(assistantName);
    const card = receiverMarket
      .locator("article")
      .filter({ hasText: assistantName });
    await card.getByRole("button", { name: "获取", exact: true }).waitFor();
    await screenshot("market-recipient-before", receiver);
    const installResponse = receiver.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`${market}/install`),
    );
    await card.getByRole("button", { name: "获取", exact: true }).click();
    const installedResponse = await installResponse;
    assert.equal(
      installedResponse.status(),
      201,
      await installedResponse.text(),
    );
    const installed = (await installedResponse.json()).installation;
    for (const id of Object.values(installed.mcp))
      cleanup.push([receiver, `${runtime}/mcp-servers/${id}`]);
    for (const id of Object.values(installed.skills))
      cleanup.push([receiver, `${runtime}/skills/${id}`]);
    cleanup.push([receiver, `${runtime}/presets/${installed.assistantId}`]);
    const receivedPreset = (await json(receiver, `${runtime}/presets`)).find(
      (p) => p.id === installed.assistantId,
    );
    assert.deepEqual(receivedPreset.skillIds, [installed.skills[skillID]]);
    assert.deepEqual(receivedPreset.mcpServerIds, [installed.mcp[mcp.id]]);
    assert.notEqual(receivedPreset.id, assistant.id);
    assert.notEqual(installed.skills[skillID], skillID);
    assert.notEqual(installed.mcp[mcp.id], mcp.id);
    assert.equal(
      (await json(receiver, `${runtime}/skills`)).find(
        (s) => s.id === installed.skills[skillID],
      ).source,
      "market",
    );
    const again = await call(receiver, `${market}/install`, { id: entry.id });
    assert.deepEqual(again.installation, installed);
    await card.getByRole("button", { name: "重新获取", exact: true }).waitFor();
    await screenshot("market-recipient-installed", receiver);
    const forbidden = await receiver.request.delete(
      `${baseURL}${market}?id=${entry.id}`,
      { headers: { Origin: baseURL } },
    );
    assert.equal(forbidden.status(), 403);
    report.market = {
      kindsPublished: ["skill", "mcp", "assistant"],
      crossAccountInstall: true,
      archiveInstalled: true,
      bindingsRemapped: true,
      repeatIdempotent: true,
      ownerOnlyUnpublish: true,
    };
  } finally {
    const failures = [];
    for (const [target, path] of cleanup.reverse()) {
      try {
        await call(target, path, undefined, "DELETE");
      } catch (e) {
        failures.push(e.message);
      }
    }
    for (const id of entries) {
      try {
        await call(page, `${market}?id=${id}`, undefined, "DELETE");
      } catch (e) {
        failures.push(e.message);
      }
    }
    await receiverContext?.close();
    if (failures.length) console.error("Fixture cleanup:", failures);
    if (output)
      await writeFile(
        `${output}/experience.json`,
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            ...report,
            cleanupFailures: failures,
          },
          null,
          2,
        ),
      );
  }
});
console.log(
  "Experience smoke passed: admin overview/collapse, dark logout, searchable assistant bindings and cross-account marketplace bundles",
);
