import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import {
  login,
  json,
  openSettingsSection,
  baseURL,
} from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium",
  out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = {
  checks: [],
  errors: [],
  preview: !!process.env.WORKAGENT_SMOKE_CLIENT,
};
const created = [];
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
page.on("pageerror", (e) => report.errors.push(e.message));
for (const [env, url] of [
  ["WORKAGENT_SMOKE_CLIENT", "**/plugins/@workagent/dsh-client/client.js*"],
  [
    "WORKAGENT_SMOKE_CHANNEL",
    "**/plugins/@michengai/dsh-im-connect/client.js*",
  ],
])
  if (process.env[env]) {
    const body = await readFile(process.env[env], "utf8");
    await page.route(url, (r) =>
      r.fulfill({ contentType: "text/javascript", body }),
    );
  }
const labels = {
  none: "无",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极高",
  off: "关闭",
  thinking: "开启",
  on: "开启",
};
async function check(select, kind) {
  await select.waitFor();
  await page.waitForFunction(
    (el) => [...el.options].some((o) => o.value === "low"),
    await select.elementHandle(),
    { timeout: 60000 },
  );
  const options = await select
    .locator("option")
    .evaluateAll((es) =>
      es.map((e) => ({ value: e.value, text: e.textContent })),
    );
  for (const o of options)
    if (labels[o.value]) assert.equal(o.text, labels[o.value]);
  assert(options.some((o) => o.value === "low" && o.text === "低"));
  report.checks.push({ kind, options });
}
try {
  await login(page);
  for (const agent of ["Codex", "Kimi"]) {
    await page.getByRole("radio", { name: agent, exact: true }).click();
    await check(page.getByLabel("思考级别", { exact: true }), `home-${agent}`);
  }
  await page
    .locator(".workagent-hero-composer")
    .screenshot({ path: `${out}/home.png` });
  for (const modelEngine of ["codex", "kimi"]) {
    const s = await json(page, "/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine: modelEngine,
        workspace: "default",
        title: `中文强度验收-${Date.now()}`,
      }),
    });
    created.push(s.id);
    await page.evaluate((id) => {
      history.pushState(null, "", `/?frontend=dsh&session=${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, s.id);
    await check(
      page.getByLabel("当前会话思考强度", { exact: true }),
      `conversation-${modelEngine}`,
    );
    await page
      .locator(".workagent-conversation-composer")
      .screenshot({ path: `${out}/conversation-${modelEngine}.png` });
  }
  const catalog = await json(page, "/dsh-im-connect/api/assistant");
  const channels = await json(page, "/dsh-im-connect/api/channels");
  const provider = catalog.providers.find((p) => p.id === "workagent-kimi");
  assert(provider);
  const model = provider.models.find((m) =>
    m.reasoning?.efforts?.some((e) => e.id === "low"),
  );
  assert(model);
  const account = {
    id: "weixin_label_fixture",
    platform: "weixin",
    name: "中文强度验收",
    connected: false,
    receiveEnabled: false,
    status: "未连接",
    configuredKeys: [],
    assistant: {
      provider: provider.id,
      model: model.id,
      reasoningEffort: "low",
    },
    cwd: catalog.cwd,
    permission: "read-only",
    privateAccess: "approved",
  };
  await page.route("**/dsh-im-connect/api/channels", (r) =>
    r.fulfill({
      json: {
        ...channels,
        channels: channels.channels.map((c) => ({
          ...c,
          total: c.id === "weixin" ? 1 : 0,
          online: 0,
          accounts: c.id === "weixin" ? [account] : [],
        })),
      },
    }),
  );
  await page.evaluate(() => {
    history.pushState(null, "", "/?frontend=dsh");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const settings = await openSettingsSection(page, "消息渠道");
  await settings.getByRole("button", { name: /中文强度验收/ }).click();
  const picker = settings.getByRole("button", {
    name: "选择助手与模型",
    exact: true,
  });
  await picker.waitFor();
  await page.waitForFunction(
    (el) => el.innerText.includes("低"),
    await picker.elementHandle(),
  );
  await picker.click();
  await settings.getByRole("menuitem").filter({ hasText: "思考强度" }).click();
  const menu = settings.locator(".ima-chip-menu");
  await menu.waitFor();
  assert(!/Thinking|\bLow\b/.test(await menu.innerText()));
  await page.screenshot({ path: `${out}/channel.png` });
  report.checks.push({ kind: "channel", text: await menu.innerText() });
  assert.deepEqual(report.errors, []);
  console.log(
    JSON.stringify({ checks: report.checks.length, errors: report.errors }),
  );
} catch (e) {
  report.failure = e.message;
  await page.screenshot({ path: `${out}/failure.png` });
  throw e;
} finally {
  for (const id of created)
    await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
