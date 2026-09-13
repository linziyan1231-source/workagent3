import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  baseURL,
  json,
  login,
  openSettingsSection,
  uniqueName,
} from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("WORKAGENT_SMOKE_EVIDENCE_DIR required");
await mkdir(evidence, { recursive: true });
const report = { checks: [], sessions: [], errors: [] };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error) => report.errors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem("workagent.files.open", "false");
  localStorage.setItem(
    "workagent.appearance.v1",
    JSON.stringify({ mode: "porcelain", daylight: "porcelain" }),
  );
  // Reproduce the HTTP browser API surface in the screenshot, even on localhost.
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${evidence}/${name}.png` });
};
async function contained(parent, child) {
  const a = await parent.boundingBox(),
    b = await child.boundingBox();
  assert(a && b, "Both controls must be visible");
  assert(
    b.x >= a.x - 1 &&
      b.y >= a.y - 1 &&
      b.x + b.width <= a.x + a.width + 1 &&
      b.y + b.height <= a.y + a.height + 1,
    `Control escapes its container: ${JSON.stringify({ a, b })}`,
  );
}
async function home() {
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page
    .getByLabel("模型", { exact: true })
    .locator("option")
    .filter({ hasText: /GPT/ })
    .first()
    .waitFor({ state: "attached", timeout: 30000 });
}
try {
  await login(page);
  await home();
  const sidebar = page.locator(".hHd-Xa_root");
  assert((await sidebar.boundingBox()).width <= 240);
  assert.equal(
    await sidebar.getByRole("button", { name: "开启桌面提醒" }).count(),
    0,
  );
  assert.equal(
    await sidebar
      .getByRole("button", { name: "共享项目", exact: true })
      .count(),
    0,
  );
  const attachment = page
    .locator(".workagent-hero-composer")
    .getByRole("button", { name: "附件", exact: true });
  assert.equal((await attachment.innerText()).trim(), "");
  assert.equal(await attachment.locator("svg").count(), 1);
  await contained(
    page.locator(".workagent-hero-composer"),
    page.getByRole("button", { name: "发送消息", exact: true }),
  );
  await sidebar.getByRole("button", { name: "多选对话", exact: true }).click();
  await sidebar.getByRole("button", { name: "结束多选", exact: true }).click();
  await shot("home-desktop");
  report.checks.push(
    "compact sidebar, icon-only attachment, send contained, batch selection",
  );
  await sidebar.getByRole("button", { name: "协作", exact: true }).click();
  await page.getByRole("button", { name: "共享项目", exact: true }).click();
  await page.locator('[data-workagent-section="共享项目"]').waitFor();
  await page.getByRole("button", { name: "智能体团队", exact: true }).click();
  await page.locator('[data-workagent-section="团队"]').waitFor();
  report.checks.push(
    "single collaboration entry reaches shared projects and agent teams",
  );
  await home();
  await openSettingsSection(page, "消息提醒");
  await page.getByRole("button", { name: /^(开启|关闭)桌面提醒$/ }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "导入记录", exact: true }).count(),
    0,
  );
  const dialog = page.getByRole("dialog", { name: /settings|设置/i });
  await dialog.getByRole("button", { name: "系统与帮助", exact: true }).click();
  await page
    .locator(".workagent-storage-card progress")
    .first()
    .waitFor({ state: "attached", timeout: 60000 });
  assert.equal(await page.locator(".workagent-storage-card").count(), 2);
  await shot("system-settings");
  await dialog.getByRole("button", { name: "MCP与技能", exact: true }).click();
  await page.getByText("批量导入 MCP JSON", { exact: true }).click();
  assert.equal(
    await page
      .locator("details[open] summary")
      .filter({ hasText: "批量导入" })
      .count(),
    1,
  );
  await shot("mcp-settings");
  report.checks.push(
    "notification settings, no import history navigation, quota cards and MCP disclosure",
  );

  const workspace = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: uniqueName("界面优化验收") }),
  });
  report.workspace = workspace.id;
  await json(
    page,
    `/api/runtime/v1/workspaces/${workspace.id}/content?path=reference.txt`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: "REFERENCE_OK",
    },
  );
  for (const engine of ["codex", "kimi"]) {
    const session = await json(page, "/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine,
        title: uniqueName(`界面-${engine}`),
        workspace: workspace.id,
        presetId: `builtin-${engine}`,
        permissionMode: "workspace_write",
        modelId: engine === "codex" ? "gpt-6-astra" : "kimi-code/kimi-k3",
        thinkingEffort: "low",
      }),
    });
    report.sessions.push({ engine, id: session.id });
    await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
    const form = page.locator(".workagent-conversation-composer");
    const input = page.getByLabel("继续对话", { exact: true });
    const model = page.getByLabel("当前会话模型");
    await model.waitFor({ timeout: 30000 });
    await contained(form, model);
    await contained(form, page.getByLabel("当前会话权限"));
    assert.equal(await page.getByLabel("当前会话渠道提醒").count(), 0);
    const effort = page.getByLabel("当前会话思考强度");
    await effort.selectOption("high");
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="当前会话思考强度"]').disabled,
    );
    await page.reload();
    await model.waitFor({ timeout: 30000 });
    assert.equal(await effort.inputValue(), "high");
    await effort.selectOption("low");
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="当前会话思考强度"]').disabled,
    );
    assert.equal(await effort.locator("option:checked").innerText(), "low");
    await input.fill("@");
    await form
      .getByRole("button", { name: "reference.txt", exact: true })
      .click();
    assert.match(await input.inputValue(), /reference\.txt/);
    await input.fill("/");
    await form.getByRole("button", { name: /发起侧聊/ }).waitFor();
    await input.fill("");
    const chooser = page.waitForEvent("filechooser");
    await form.getByRole("button", { name: "附件", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "附件.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("UPLOAD_OK"),
    });
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="继续对话"]')
        .value.includes("附件.txt"),
    );
    await input.fill("只回复 UI_REFINED_OK，不使用工具。");
    await form.getByRole("button", { name: "发送", exact: true }).click();
    await page
      .locator(".workagent-message.is-assistant")
      .getByText("UI_REFINED_OK", { exact: true })
      .waitFor({ timeout: 120000 });
    assert.equal(
      await page.getByRole("button", { name: "引用", exact: true }).count(),
      0,
    );
    assert.equal(await page.locator(".workagent-quote").count(), 0);
    for (const action of await page
      .locator(".workagent-message-action")
      .all()) {
      assert.equal((await action.innerText()).trim(), "");
      assert.equal(await action.locator("svg").count(), 1);
    }
    let completed;
    const deadline = Date.now() + 30000;
    do {
      completed = await json(page, `/api/runtime/v1/sessions/${session.id}`);
      if (
        completed.lastTurn &&
        ["completed", "failed", "cancelled"].includes(completed.lastTurn.status)
      )
        break;
      await page.waitForTimeout(500);
    } while (Date.now() < deadline);
    assert.equal(completed.lastTurn?.status, "completed");
    await contained(
      form,
      form.getByRole("button", { name: "发送", exact: true }),
    );
    await shot(`${engine}-conversation`);
    report.checks.push(
      `${engine}: HTTP UUID compatibility, saved thinking choice, @ and / menus, attachment upload, native send/reply`,
    );
    if (engine === "kimi") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(350);
      const rail = page.getByRole("button", {
        name: "打开侧边栏",
        exact: true,
      });
      await rail.click();
      await page.locator(".hHd-Xa_root:not(.hHd-Xa_collapsed)").waitFor();
      await page
        .getByRole("button", { name: "收起导航菜单", exact: true })
        .click();
      await page.locator(".hHd-Xa_collapsed").waitFor();
      await contained(
        form,
        form.getByRole("button", { name: "发送", exact: true }),
      );
      await shot("conversation-mobile");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openSettingsSection(page, "消息提醒");
      const reminder = page.getByLabel("当前会话渠道提醒");
      for (const value of ["off", "inherit"]) {
        await page.waitForFunction(
          () =>
            !document.querySelector('[aria-label="当前会话渠道提醒"]').disabled,
        );
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              "/api/runtime/v1/completion-notifications/session" &&
            response.request().method() === "PUT",
        );
        await reminder.selectOption(value);
        const setting = await (await saved).json();
        assert.equal(
          setting.mutedSessions.includes(session.id),
          value === "off",
        );
      }
      report.checks.push(
        "per-conversation reminders preserved in notification settings",
      );
    }
  }
  await home();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await contained(
      page.locator(".workagent-hero-composer"),
      page.getByRole("button", { name: "发送消息", exact: true }),
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await shot(`home-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    localStorage.setItem(
      "workagent.appearance.v1",
      JSON.stringify({ mode: "graphite", daylight: "porcelain" }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "workagent.appearance.v1" }),
    );
  });
  await page.locator('body[data-workagent-theme="graphite"]').waitFor();
  await shot("home-dark");
  report.checks.push(
    "1280/390 layout, mobile conversation navigation, dark theme",
  );
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(
    `${evidence}/refined-ui-report.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(report));
