import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { chromium } from "playwright";

const base = process.env.WORKAGENT_SMOKE_URL || "http://127.0.0.1:18300";
const fixture = process.env.WORKAGENT_MARKET_FIXTURE === "1";
const out = resolve(
  process.env.WORKAGENT_SMOKE_EVIDENCE_DIR || ".cache/market-versions/browser",
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const errors = [],
  writes = [];
const checks = [];
let currentPage;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  currentPage = page;
  page.on("pageerror", (e) => errors.push(e.message));
  const auth = await page.request.post(`${base}/api/auth/login`, {
    headers: { Origin: base },
    data: { username: "test", password: process.env.WORKAGENT_SMOKE_PASSWORD },
  });
  assert(auth.ok(), `login ${auth.status()}`);
  const versions = [
    {
      id: "fixture-version-two",
      seriesId: "fixture-series",
      kind: "skill",
      name: "图纸检查",
      version: "2.0.0",
      publisher: "publisher",
      releaseNotes: "修复计算规则，补充边界示例",
      createdAt: "2026-09-12T00:00:00Z",
    },
    {
      id: "fixture-version-one",
      seriesId: "fixture-series",
      kind: "skill",
      name: "图纸检查",
      version: "1.0.0",
      publisher: "publisher",
      releaseNotes: "初始版本",
      createdAt: "2026-09-11T00:00:00Z",
    },
  ];
  let selected = versions[1],
    subscribed = versions[1];
  let personalSubscription;
  if (fixture) {
    await page.route(url=>url.pathname.startsWith("/api/portal/projects/"),async r=>{
      if(r.request().method()==="POST"){writes.push(r.request().postDataJSON());personalSubscription=versions[0];}
      return r.fulfill({json:{canManage:true,subscriptions:personalSubscription?[{entry:personalSubscription,latest:versions[0],updateAvailable:false}]:[]}});
    });
    await page.route("**/plugins/@workagent/dsh-client/client.js*", (r) =>
      r.fulfill({
        contentType: "text/javascript",
        path: resolve("packages/dsh-client-workagent/client.js"),
      }),
    );
    await page.route(
      (url) => url.pathname.startsWith("/api/portal/marketplace"),
      async (r) => {
        const req = r.request(),
          url = new URL(req.url());
        let result = {};
        if (req.method() === "POST") {
          writes.push(req.postDataJSON());
          selected = versions[0];
          result = { results: [{ id: selected.id, success: true }] };
        } else if (url.pathname.endsWith("/versions")) result = { versions };
        else
          result = {
            entries: [
              {
                ...versions[0],
                selectedId: selected.id,
                installedVersion: selected.version,
                updateAvailable: selected.id !== versions[0].id,
                installed: true,
              },
            ],
          };
        await r.fulfill({ json: result });
      },
    );
    await page.route(
      (url) => url.pathname.startsWith("/api/portal/shared-projects"),
      async (r) => {
        const req = r.request();
        if (new URL(req.url()).pathname.endsWith("/capabilities")) {
          if (req.method() === "POST") {
            writes.push(req.postDataJSON());
            subscribed = versions[0];
          }
          return r.fulfill({
            json: {
              canManage: true,
              subscriptions: [
                {
                  entry: subscribed,
                  latest: versions[0],
                  updateAvailable: subscribed.id !== versions[0].id,
                },
              ],
            },
          });
        }
        return r.fulfill({
          json: { projects: [{ id: "fixture-project", name: "示范协作项目" }] },
        });
      },
    );
  }
  await page.goto(`${base}/?frontend=dsh&workagent=marketplace`);
  await page.getByRole("heading", { name: "市场", exact: true }).waitFor();
  await page.getByLabel("能力使用范围", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "重新加载能力", exact: true })
      .count(),
    0,
  );
  if (fixture) {
    assert.equal(writes.length, 0, "opening market must not auto-update");
    await page.getByText("当前安装：1.0.0", { exact: true }).waitFor();
    await page.getByRole("button", { name: "版本记录", exact: true }).click();
    await page
      .getByRole("heading", { name: "图纸检查 · 版本记录", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "使用 2.0.0", exact: true }).click();
    await page.getByText("当前安装：2.0.0", { exact: true }).waitFor();
    await page.getByLabel("能力使用范围", { exact: true }).selectOption("personal:default");
    await page.getByRole("button",{name:"订阅此版本",exact:true}).click();
    await page.getByText("当前订阅：2.0.0",{exact:true}).waitFor();
    checks.push("personal project subscription");
    await page
      .getByLabel("能力使用范围", { exact: true })
      .selectOption("fixture-project");
    await page.getByText("当前订阅：1.0.0", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "一键更新（1）", exact: true })
      .click();
    await page.getByText("当前订阅：2.0.0", { exact: true }).waitFor();
    checks.push(
      "manual version update with visible feedback",
      "personal update leaves project pinned",
      "project one-click update",
    );
  } else {
    const response = await page.request.get(`${base}/api/portal/marketplace`);
    assert(response.ok(), `market ${response.status()}`);
    const data = await response.json();
    assert(Array.isArray(data.entries));
    for (const e of data.entries)
      assert(e.seriesId && typeof e.updateAvailable === "boolean");
    checks.push("authenticated production marketplace and version contract");
  }
  await page.screenshot({ path: resolve(out, "market-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("heading", { name: "市场", exact: true }).waitFor();
  await page.getByLabel("能力使用范围", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(out, "market-mobile.png"), animations: "disabled" });
  const admin = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    adminPage = await admin.newPage();
  adminPage.on("pageerror", (e) => errors.push(e.message));
  const logged = await adminPage.request.post(`${base}/api/auth/login`, {
    headers: { Origin: base },
    data: {
      username: "admin",
      password: process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD,
    },
  });
  assert(logged.ok(), `admin login ${logged.status()}`);
  if (fixture) {
    await adminPage.route("**/admin/accounts", (r) =>
      r.fulfill({
        contentType: "text/html",
        path: resolve("apps/web/dist/index.html"),
      }),
    );
    await adminPage.route("**/assets/*", (r) =>
      r.fulfill({
        path: resolve(
          "apps/web/dist/assets",
          basename(new URL(r.request().url()).pathname),
        ),
      }),
    );
    await adminPage.route("**/api/portal/admin/marketplace", async (r) => {
      if (r.request().method() === "POST")
        writes.push(r.request().postDataJSON());
      return r.fulfill({ json: { entries: versions, actions: [] } });
    });
  }
  await adminPage.goto(`${base}/admin/accounts`);
  await adminPage
    .getByRole("button", { name: "市场能力", exact: true })
    .click();
  await adminPage
    .getByRole("heading", { name: "市场能力管理", exact: true })
    .waitFor();
  if (fixture) {
    await adminPage
      .getByRole("button", { name: "删除", exact: true })
      .click();
    const panel = adminPage.getByRole("region", { name: "确认安全处置" });
    assert(
      await panel
        .getByRole("button", { name: "确认删除", exact: true })
        .isDisabled(),
    );
    await panel.getByRole("textbox").fill("确认示范漏洞已影响所有安装版本");
    await panel
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    assert(writes.some((w) => w.action === "delete" && w.reason));
    checks.push(
      "admin security action requires reason and explicit confirmation",
    );
  } else {
    assert(
      (
        await adminPage.request.get(`${base}/api/portal/admin/marketplace`)
      ).ok(),
    );
    checks.push("authenticated production administrator management");
  }
  await adminPage.screenshot({ path: resolve(out, "market-admin.png") });
  assert.deepEqual(errors, []);
  checks.push(
    "desktop/mobile rendering without page errors",
    "ineffective main reload button removed",
  );
  await writeFile(
    resolve(out, "report.json"),
    JSON.stringify({ status: "passed", fixture, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ status: "passed", fixture, checks }));
} catch (error) {
  if (currentPage) {
    await currentPage.screenshot({ path: resolve(out, "failure.png") });
    console.log(
      JSON.stringify({
        errors,
        text: (
          await currentPage.locator(".workagent-overlay").innerText()
        ).slice(0, 2500),
        url: currentPage.url(),
      }),
    );
  }
  throw error;
} finally {
  await browser.close();
}
