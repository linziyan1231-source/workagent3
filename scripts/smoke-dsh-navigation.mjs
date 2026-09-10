import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { baseURL, json, login } from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("Evidence directory required");
await mkdir(evidence, { recursive: true });
const report = {
  checks: [],
  errors: [],
  sessions: [],
  documents: 0,
  plugins: 0,
  connections: 0,
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("request", (request) => {
  if (request.isNavigationRequest() && request.frame() === page.mainFrame())
    report.documents++;
  if (request.url().includes("/plugins/")) report.plugins++;
});
page.on("websocket", () => report.connections++);
if (process.env.WORKAGENT_SMOKE_CLIENT) {
  const client = await readFile(process.env.WORKAGENT_SMOKE_CLIENT, "utf8");
  await page.route("**/plugins/@workagent/dsh-client/client.js*", (route) =>
    route.fulfill({ contentType: "text/javascript", body: client }),
  );
}
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
const select = async (session) => {
  if (await page.getByRole("button", { name: "搜索对话", exact: true }).count())
    await page.getByRole("button", { name: "搜索对话", exact: true }).click();
  await page.getByPlaceholder("搜索对话…", { exact: true }).fill("界面-");
  for (const button of await page
    .locator('.workagent-sidebar-project-row .is-main[aria-expanded="false"]')
    .all())
    await button.click();
  await page
    .locator(".workagent-sidebar-session .is-main")
    .filter({ hasText: session.title })
    .click();
  await page.waitForFunction(
    (id) => new URLSearchParams(location.search).get("session") === id,
    session.id,
  );
  await page
    .locator(".workagent-conversation-title strong")
    .filter({ hasText: session.title })
    .waitFor();
  assert.equal(
    await page
      .locator('.workagent-sidebar-session .is-main[aria-current="page"]')
      .innerText(),
    session.title,
  );
};
try {
  await login(page);
  // Read known acceptance conversations; no user messages or runtime settings change.
  const rows = await json(page, "/api/runtime/v1/sessions");
  for (const engine of ["codex", "kimi"]) {
    const session = rows.find(
      (row) => row.engine === engine && row.title?.startsWith("界面-"),
    );
    assert(session, `Missing ${engine} UI acceptance conversation`);
    report.sessions.push(session);
  }
  await page.evaluate(() => (window.__navigationSmokeDocument = "unchanged"));
  const baseline = {
    documents: report.documents,
    plugins: report.plugins,
    connections: report.connections,
  };
  const [first, second] = report.sessions;
  await select(first);
  await page.locator(".workagent-message.is-assistant").first().waitFor();
  const firstMessage = await page
    .locator(".workagent-message.is-assistant")
    .first()
    .innerText();
  // Make this short acceptance transcript scrollable without changing its data.
  const scrollStyle = await page.addStyleTag({
    content:
      ".workagent-message-list .workagent-message { min-height: 650px; }",
  });
  await page.locator(".workagent-message-list").evaluate((list) => {
    list.scrollTop = 180;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const input = page.getByLabel("继续对话", { exact: true });
  await input.fill("navigation draft A");
  await select(second);
  await page.locator(".workagent-message.is-assistant").first().waitFor();
  assert.equal(await input.inputValue(), "");
  await input.fill("navigation draft B");
  await select(first);
  assert.equal(await input.inputValue(), "navigation draft A");
  assert.equal(
    await page
      .locator(".workagent-message-list")
      .evaluate((list) => list.scrollTop),
    180,
  );
  assert.equal(
    await page.locator(".workagent-message.is-assistant").first().innerText(),
    firstMessage,
  );
  report.checks.push(
    "Codex/Kimi in-page switching, message identity, isolated drafts, scroll restoration",
  );
  await page.goBack();
  await page.waitForFunction(
    (id) => new URLSearchParams(location.search).get("session") === id,
    second.id,
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="继续对话"]')?.value ===
      "navigation draft B",
  );
  await page.goForward();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="继续对话"]')?.value ===
      "navigation draft A",
  );
  report.checks.push("browser back and forward restore route and draft");
  // Consecutive clicks within one event loop exercise aborted history loads.
  await page.evaluate(
    (titles) => {
      for (const title of titles) {
        const button = [
          ...document.querySelectorAll(".workagent-sidebar-session .is-main"),
        ].find((el) => el.textContent.trim() === title);
        button.click();
      }
    },
    [second.title, first.title, second.title],
  );
  await page.waitForFunction(
    (id) => new URLSearchParams(location.search).get("session") === id,
    second.id,
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="继续对话"]')?.value ===
      "navigation draft B",
  );
  await input.fill("");
  await select(first);
  await scrollStyle.evaluate((style) => style.remove());
  await input.fill("");
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  await page.locator(".workagent-hero-composer").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), null);
  await page.getByRole("button", { name: "协作", exact: true }).click();
  await page.locator(".workagent-collaboration").waitFor();
  await select(first);
  assert.equal(
    await page.evaluate(() => window.__navigationSmokeDocument),
    "unchanged",
  );
  assert.equal(
    report.documents,
    baseline.documents,
    "No document navigation on chat/home/page changes",
  );
  assert.equal(report.plugins, baseline.plugins, "Plugins must remain loaded");
  assert.equal(
    report.connections,
    baseline.connections,
    "Runtime connection must remain open",
  );
  report.checks.push(
    "rapid switching, home, collaboration, zero document/plugin/socket reloads",
  );
  await page.screenshot({ path: `${evidence}/navigation-desktop.png` });
  await page.setViewportSize({ width: 390, height: 740 });
  await select(second);
  assert.equal(
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).count(),
    1,
  );
  report.checks.push(
    "mobile chat selection closes navigation and keeps the document",
  );
  await page.getByLabel("当前会话模型", { exact: true }).waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${evidence}/navigation-mobile.png` });
  assert.deepEqual(report.errors, []);
  report.sessions = report.sessions.map(({ id, engine }) => ({ id, engine }));
  console.log(JSON.stringify(report));
} finally {
  await writeFile(
    `${evidence}/navigation-report.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
