import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { baseURL, requireSmokeEnvironment } from "./smoke-dsh-helpers.mjs";

requireSmokeEnvironment();
const out = resolve(
  process.env.WORKAGENT_SMOKE_EVIDENCE_DIR ||
    ".cache/sidebar-presentation/browser",
);
const candidate = resolve(
  process.env.WORKAGENT_SIDEBAR_CLIENT_DIR || "packages/dsh-client-workagent",
);
const channel = await readFile(
  resolve(
    process.env.WORKAGENT_SMOKE_IM_CLIENT ||
      ".cache/sidebar-im-patch/lib/client.js",
  ),
  "utf8",
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const report = {
  checks: [],
  rows: [],
  errors: [],
  screenshots: [],
  blockedWrites: [],
  mode: "authenticated shell, candidate assets and browser-only fixtures",
};
const project = {
  id: "sidebar-shared-project",
  name: "侧栏验收项目",
  currentRole: "owner",
};
const session = {
  id: "sidebar-session",
  title: "侧栏格式验收对话",
  engine: "codex",
  agentPresetId: "builtin-general",
  workspaceId: "sidebar-project",
  updatedAt: "2026-09-12T06:00:00Z",
  activity: { state: "idle" },
};
const discussion = {
  id: "sidebar-discussion",
  project_id: project.id,
  name: "侧栏格式验收对话",
  kind: "discussion",
  state: "idle",
};
const workspaces = [
  { id: "sidebar-project", name: "侧栏验收项目", kind: "directory" },
];
const presets = [
  {
    id: "builtin-general",
    name: "Codex",
    engine: "codex",
    enabled: true,
    source: "builtin",
    skillIds: [],
    mcpServerIds: [],
    toolAllowlist: [],
  },
];
let current;
try {
  for (const [label, viewport, theme] of [
    ["desktop-light", { width: 1440, height: 960 }, "porcelain"],
    ["mobile-light", { width: 390, height: 844 }, "porcelain"],
    ["desktop-dark", { width: 1440, height: 960 }, "graphite"],
    ["mobile-dark", { width: 390, height: 844 }, "graphite"],
  ]) {
    const page = await browser.newPage({ viewport });
    current = page;
    page.setDefaultTimeout(12000);
    page.on("pageerror", (error) =>
      report.errors.push({ layout: label, message: error.message }),
    );
    await page.addInitScript(
      ({ theme }) => {
        localStorage.setItem(
          "workagent.appearance.v1",
          JSON.stringify({ mode: theme, daylight: "porcelain" }),
        );
        localStorage.setItem("workagent.files.open", "false");
        localStorage.setItem("workagent.font-size", "14");
      },
      { theme },
    );
    for (const name of ["client.js", "tokens.css"])
      await page.route(`**/plugins/@workagent/dsh-client/${name}*`, (route) =>
        route.fulfill({
          path: resolve(candidate, name),
          contentType: name.endsWith("css") ? "text/css" : "text/javascript",
        }),
      );
    await page.route(
      "**/plugins/@michengai/dsh-im-connect/client.js*",
      (route) =>
        route.fulfill({ body: channel, contentType: "text/javascript" }),
    );
    await page.route(/\/api\//, async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      const write = !["GET", "HEAD", "OPTIONS"].includes(request.method());
      if (path === "/dsh-im-connect/api/channels")
        return route.fulfill({
          json: {
            ok: true,
            groups: [
              {
                id: "weixin",
                label: "微信",
                sessions: [
                  {
                    channel: "weixin",
                    kind: "private",
                    chatId: "raw-sidebar-id",
                    chatTitle: "raw-sidebar-id",
                    sessionId: session.id,
                    title: session.title,
                    updatedAt: session.updatedAt,
                  },
                ],
              },
            ],
          },
        });
      if (path.startsWith("/api/session.")) {
        const body = request.postDataJSON();
        const value = path.endsWith(".list")
          ? { items: [], hasMore: false }
          : path.endsWith(".history")
            ? {
                events: [],
                hasMore: false,
                projections: {
                  asOfSeq: 1,
                  values: {
                    nativeSession: {
                      sequence: 1,
                      metadata: session,
                      messages: [],
                      processes: {},
                      tools: {},
                      draft: "",
                      activity: { state: "idle" },
                    },
                  },
                },
              }
            : path.endsWith(".models")
              ? { routable: true, groups: [], failures: [] }
              : {};
        return route.fulfill({
          json: {
            type: "server-response",
            rpcId: body.rpcId,
            result: { ok: true, value },
          },
        });
      }
      if (path.startsWith("/api/portal/shared-")) {
        if (path.endsWith("shared-events"))
          return route.fulfill({
            contentType: "text/event-stream",
            body: ": ready\n\n",
          });
        const value = path.endsWith("shared-projects")
          ? { projects: [project] }
          : path.endsWith("shared-conversations")
            ? { conversations: [discussion] }
            : path.endsWith("shared-invites")
              ? { invites: [] }
              : path.endsWith("/members")
                ? { members: [] }
                : path.endsWith("shared-messages")
                  ? { messages: [] }
                  : {};
        if (write)
          report.blockedWrites.push({ method: request.method(), path });
        return route.fulfill({ json: value });
      }
      if (path.startsWith("/api/runtime/v1")) {
        const suffix = path.slice("/api/runtime/v1".length);
        const value =
          suffix === "/sessions"
            ? [session]
            : suffix === `/sessions/${session.id}`
              ? session
              : suffix === "/workspaces"
                ? workspaces
                : suffix === "/presets"
                  ? presets
                  : suffix === "/provider-models"
                    ? []
                    : suffix === "/completion-notifications"
                      ? { enabled: false, targets: [], sessionSettings: {} }
                      : [];
        if (suffix.endsWith("/events"))
          return route.fulfill({
            contentType: "text/event-stream",
            body: ": ready\n\n",
          });
        if (write)
          report.blockedWrites.push({ method: request.method(), path });
        return route.fulfill({ json: value });
      }
      if (write) {
        report.blockedWrites.push({ method: request.method(), path });
        return route.fulfill({ json: {} });
      }
      return route.continue();
    });
    const authentication = await page.request.post(
      `${baseURL}/api/auth/login`,
      {
        data: {
          username: process.env.WORKAGENT_SMOKE_USERNAME,
          password: process.env.WORKAGENT_SMOKE_PASSWORD,
        },
        headers: { Origin: new URL(baseURL).origin },
      },
    );
    assert(authentication.ok(), "shell login succeeds");
    await page.goto(`${baseURL}/?frontend=dsh`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(".workagent-sidebar-tabs")
      .waitFor({ state: "attached" });
    await page.waitForTimeout(350);
    const activeSidebar = page.locator(
      ".hHd-Xa_root:not(.hHd-Xa_collapsed):not(.hHd-Xa_fading)",
    );
    if (!(await activeSidebar.count()))
      await page
        .locator(".hHd-Xa_toggle, .wSkVaW_sidebarToggle")
        .first()
        .click();
    await activeSidebar.waitFor();
    const samples = [];
    for (const [tab, scope] of [
      [
        "任务",
        ".workagent-sidebar-browser:not(.workagent-collab-sidebar):not(.workagent-channel-sidebar)",
      ],
      ["频道", ".workagent-channel-sidebar"],
      ["协作", ".workagent-collab-sidebar"],
    ]) {
      await activeSidebar
        .getByRole("button", { name: tab, exact: true })
        .click();
      const sidebar = activeSidebar.locator(scope);
      const row = sidebar
        .locator(".workagent-sidebar-session")
        .filter({ hasText: "侧栏格式验收对话" })
        .first();
      await row.waitFor();
      const values = await row.evaluate((node) => {
        const main = node.querySelector(".is-main"),
          title = node.querySelector(".workagent-session-title"),
          style = getComputedStyle(main);
        return {
          font: style.fontSize,
          height: main.getBoundingClientRect().height,
          radius: style.borderRadius,
          titleX: title.getBoundingClientRect().x,
          rowX: node.getBoundingClientRect().x,
        };
      });
      samples.push({ tab, ...values });
      await page.screenshot({ path: resolve(out, `${label}-${tab}.png`) });
      report.screenshots.push(`${label}-${tab}.png`);
      if (tab === "频道") {
        assert.equal(await sidebar.locator(".ima-n-sess").count(), 0);
        assert.equal(
          (await sidebar.innerText()).includes("raw-sidebar-id"),
          false,
        );
        const more = row.getByRole("button", { name: /更多/ });
        await more.focus();
        assert.equal(
          await more.evaluate((node) => getComputedStyle(node).opacity),
          "1",
        );
        await more.click();
        const dialog = page.locator("[data-workagent-dialog]");
        await dialog.waitFor();
        assert.equal(await dialog.locator(".workagent-action-list").count(), 1);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
      }
    }
    assert.equal(
      new Set(samples.map((row) => row.font)).size,
      1,
      `${label}: font matches`,
    );
    assert.equal(
      new Set(samples.map((row) => row.radius)).size,
      1,
      `${label}: radius matches`,
    );
    assert.ok(
      Math.max(...samples.map((row) => row.height)) -
        Math.min(...samples.map((row) => row.height)) <=
        1,
      `${label}: row height matches`,
    );
    assert.ok(
      Math.max(...samples.map((row) => row.titleX - row.rowX)) -
        Math.min(...samples.map((row) => row.titleX - row.rowX)) <=
        1,
      `${label}: title inset matches`,
    );
    report.rows.push({ layout: label, samples });
    report.checks.push(
      `${label}: all three tabs use shared row geometry, keyboard menu and Escape work`,
    );
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.message;
  if (current && !current.isClosed())
    await current.screenshot({ path: resolve(out, "failure.png") });
  throw error;
} finally {
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
