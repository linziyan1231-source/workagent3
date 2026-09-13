// Real product components/CSS with a loopback-only fake API. No production
// credentials, saved browser profiles, real engines or paid providers are used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { bundleStyles } from "../packages/dsh-client-workagent/build.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const onceLayout = process.argv.includes("--once-layout");
const output = join(
  root,
  ".cache/parity-20260912/browser",
  ...(onceLayout ? ["once-layout"] : []),
);
const requireClient = createRequire(
  new URL("../packages/dsh-client-workagent/package.json", import.meta.url),
);
const { build } = requireClient("esbuild");
await mkdir(output, { recursive: true });
const buildResult = await build({
  entryPoints: [join(root, "scripts/fixtures/parity-ui.jsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  write: false,
  jsx: "automatic",
  outfile: join(output, "fixture.js"),
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  alias: {
    react: dirname(requireClient.resolve("react/package.json")),
    "react-dom": dirname(requireClient.resolve("react-dom/package.json")),
  },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
});
const script = buildResult.outputFiles.find((file) =>
  file.path.endsWith(".js"),
).text;
const upstreamStyles =
  buildResult.outputFiles.find((file) => file.path.endsWith(".css"))?.text ||
  "";
const { code: dshStyles } = await bundleStyles();
const adminStyles = await readFile(
  join(root, "apps/web/src/features/admin/AdminPortal.css"),
  "utf8",
);
const typographyStyles = await readFile(
  join(root, "apps/web/src/shared/ui/typography.css"),
  "utf8",
);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>WorkAgent 隔离组件验收</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}main{max-width:1000px;margin:0 auto;padding:20px}.fixture-label{border-bottom:1px solid var(--dsw-color-border);padding-bottom:12px;color:var(--dsw-color-muted)}#root{min-width:0}</style><div id="root"></div><script type="module" src="/fixture.js"></script></html>`;
const catalog = () => ({
  id: "approved",
  label: "验收 ACP 引擎",
  revision: "v1",
  enabled: true,
  billingModelId: "codex-native",
  ready: false,
  permissionModes: {},
  credentialFields: [
    { id: "key", label: "API Key", required: true, configured: false },
  ],
});
const presets = [
  { id: "builtin-codex", name: "Codex", engine: "codex", enabled: true },
  {
    id: "approved-preset",
    name: "验收 ACP 助手",
    engine: "acp",
    acpCatalogId: "approved",
    enabled: true,
  },
];
let state, failure, base;
const reset = () => {
  state = {
    requests: [],
    feedback: [
      {
        id: "feedback-existing",
        username: "验收用户",
        description: "隔离反馈示例",
        steps: "打开本地页面",
        status: "new",
        savedAt: new Date().toISOString(),
        attachments: [],
      },
    ],
    apps: [
      {
        id: "app-seeded",
        workspaceId: "fixture-project",
        name: "示例网页",
        kind: "static",
        entry: "index.html",
        access: "token",
        enabled: true,
        version: "v1",
        versions: ["v1"],
        shareUrl: base ? `${base}/t/share-token-x/` : "http://127.0.0.1/t/share-token-x/",
        url: base ? `${base}/apps/app-seeded` : "http://127.0.0.1/apps/app-seeded",
        expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(),
      },
    ],
    catalog: catalog(),
    teams: [],
    runs: [],
    automations: [],
  };
  failure = null;
};
reset();
const json = (res, body, status = 200) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base || "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/fixture.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(script);
      return;
    }
    if (path === "/fixture.css") {
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end(
        upstreamStyles +
          "\n" +
          dshStyles +
          "\n" +
          adminStyles +
          "\n" +
          typographyStyles,
      );
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    let body = {};
    if (
      bytes.length &&
      (req.headers["content-type"]?.includes("application/json") ||
        bytes.toString().trimStart().startsWith("{"))
    )
      body = JSON.parse(bytes.toString());
    else if (
      bytes.length &&
      req.headers["content-type"]?.includes("multipart/form-data")
    ) {
      const form = await new Request(base + req.url, {
        method: req.method,
        headers: req.headers,
        body: bytes,
      }).formData();
      body = Object.fromEntries(
        [...form].filter(([, value]) => typeof value === "string"),
      );
      body.attachments = form
        .getAll("attachments")
        .map((file) => ({ name: file.name, size: file.size }));
    }
    if (path === "/__fixture/reset") {
      reset();
      json(res, {});
      return;
    }
    if (path === "/__fixture/fail") {
      failure = body;
      json(res, {});
      return;
    }
    if (path === "/__fixture/state") {
      json(res, state);
      return;
    }
    state.requests.push({ path, method: req.method, body });
    if (failure?.path === path && failure.method === req.method) {
      failure = null;
      json(res, { error: "fixture_submit_failed" }, 503);
      return;
    }
    if (path === "/api/system/feedback") {
      if (req.method === "POST") {
        const row = {
          ...body,
          id: "feedback-created",
          username: "验收用户",
          savedAt: new Date().toISOString(),
          status: "new",
        };
        state.feedback.push(row);
        json(res, row);
      } else json(res, { items: state.feedback });
      return;
    }
    if (path.startsWith("/api/system/feedback/") && req.method === "PATCH") {
      Object.assign(
        state.feedback.find((row) => path.endsWith(row.id)),
        body,
      );
      json(res, {});
      return;
    }
    if (
      path === "/api/runtime/v1/acp-catalog" ||
      path === "/api/portal/admin/acp-catalog"
    ) {
      json(res, { entries: [state.catalog] });
      return;
    }
    if (path === "/api/portal/admin/acp-catalog/approved") {
      Object.assign(state.catalog, body);
      json(res, { success: true });
      return;
    }
    if (path === "/api/runtime/v1/acp-catalog/approved/credentials") {
      state.catalog.credentialFields[0].configured = !!body.values.key;
      state.catalog.ready = !!body.values.key;
      json(res, state.catalog);
      return;
    }
    if (path === "/api/runtime/v1/presets") {
      json(res, presets);
      return;
    }
    if (path === "/api/runtime/v1/workspaces") {
      json(res, [{ id: "fixture-project", name: "验收项目" }]);
      return;
    }
    if (
      path === "/api/runtime/v1/sessions" ||
      path === "/api/runtime/v1/skills"
    ) {
      json(res, []);
      return;
    }
    if (path === "/api/runtime/v1/completion-notifications") {
      json(res, { enabled: false, targets: [] });
      return;
    }
    if (path === "/api/runtime/v1/automations") {
      if (req.method === "POST") {
        const row = {
          ...body,
          id: "automation-created",
          version: 1,
          nextRunAt: body.schedule.at,
        };
        state.automations.push(row);
        json(res, row);
      } else json(res, state.automations);
      return;
    }
    if (path === "/api/runtime/v1/teams") {
      if (req.method === "POST") {
        const team = {
          ...body,
          id: "team-created",
          version: 1,
          members: [{ ...body.lead, id: "lead", role: "lead", status: "idle" }],
        };
        state.teams.push(team);
        json(res, team);
      } else json(res, state.teams);
      return;
    }
    if (path === "/api/runtime/v1/teams/team-created/runs") {
      if (req.method === "POST") {
        const run = {
          ...body,
          id: "run-created",
          status: "running",
          segment: 1,
          dispatchCount: 1,
        };
        state.runs.push(run);
        json(res, run);
      } else json(res, state.runs);
      return;
    }
    if (
      path.startsWith("/api/runtime/v1/teams/team-created/runs/run-created/")
    ) {
      state.runs[0].status = path.endsWith("/pause")
        ? "paused"
        : path.endsWith("/cancel")
          ? "cancelled"
          : "running";
      json(res, state.runs[0]);
      return;
    }
    if (path.startsWith("/api/runtime/v1/teams/")) {
      if (req.headers.accept === "text/event-stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(": fixture\n\n");
      } else json(res, []);
      return;
    }
    if (path === "/api/portal/apps") {
      json(res, { items: state.apps });
      return;
    }
    if (path.startsWith("/api/portal/apps/app-seeded/")) {
      const app = state.apps[0];
      if (path.endsWith("/unpublish")) {
        app.enabled = false;
        json(res, app);
      } else if (path.endsWith("/enable")) {
        app.enabled = true;
        app.expiresAt = new Date(Date.now() + 5 * 86400000).toISOString();
        json(res, app);
      } else if (path.endsWith("/delete")) {
        state.apps = [];
        json(res, { deleted: true });
      } else json(res, {});
      return;
    }
    json(res, { error: "fixture_route_missing", path }, 404);
  } catch (error) {
    json(res, { error: String(error) }, 500);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;
const report = {
  fixture: true,
  productionAccess: false,
  physicalDeviceAcceptance: false,
  startedAt: new Date().toISOString(),
  browserRuns: [],
  screenshots: [],
  limitations: [
    "Real product components and CSS; isolated HTTP fixture replaces Portal, UserHost and engines.",
    "Preview interaction uses a same-origin fixture iframe; it does not verify production app origin/security isolation.",
    "Emulated touch devices verify computed font/layout only, not native iPhone keyboard zoom.",
  ],
};
const editable =
  "input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([readonly]),textarea:not([readonly]),select,[contenteditable=true]";
let activeBrowser, activePage;
async function failNext(page, path, method = "POST") {
  await page.request.post(base + "/__fixture/fail", { data: { path, method } });
}
async function data(page) {
  return (await page.request.get(base + "/__fixture/state")).json();
}
async function recordShot(page, name) {
  // Full-page capture temporarily changes Chromium device metrics and this
  // pinned Playwright version loses touch emulation on restoration.
  await page.screenshot({ path: join(output, name + ".png"), fullPage: false });
  report.screenshots.push(name + ".png");
}
async function assertRetained(locator, value) {
  assert.equal(await locator.inputValue(), value);
}
try {
  for (const [browserName, browserType] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    let browser;
    try {
      browser = await browserType.launch();
    } catch (error) {
      report.browserRuns.push({ browserName, unavailable: String(error) });
      if (browserName === "chromium") throw error;
      continue;
    }
    activeBrowser = browser;
    const run = {
      browserName,
      version: browser.version(),
      flows: [],
      typography: [],
      errors: [],
      console: [],
      findings: [],
    };
    report.browserRuns.push(run);
    if (!onceLayout) {
      const desktop = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      });
      await desktop.route("**/*", (route) =>
        new URL(route.request().url()).origin === base
          ? route.continue()
          : route.abort(),
      );
      const page = await desktop.newPage();
      activePage = page;
      page.on("pageerror", (error) => run.errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error")
          run.console.push(message.text());
      });
      const open = async (screen) => {
        await page.request.post(base + "/__fixture/reset");
        await page.goto(base + "?screen=" + screen);
      };
      await open("feedback");
      await page
        .getByLabel("问题描述", { exact: true })
        .fill("提交失败后应保留描述");
      await page
        .getByLabel("复现步骤", { exact: true })
        .fill("步骤一：打开隔离页面");
      await page.getByLabel("反馈附件").setInputFiles({
        name: "fixture-summary.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("local fixture only"),
      });
      await failNext(page, "/api/system/feedback");
      await page.getByRole("button", { name: "提交反馈", exact: true }).click();
      await page
        .getByRole("status")
        .filter({ hasText: "fixture_submit_failed" })
        .waitFor();
      await assertRetained(
        page.getByLabel("问题描述", { exact: true }),
        "提交失败后应保留描述",
      );
      await assertRetained(
        page.getByLabel("复现步骤", { exact: true }),
        "步骤一：打开隔离页面",
      );
      await recordShot(page, browserName + "-feedback-error");
      await page.getByRole("button", { name: "提交反馈", exact: true }).click();
      await page
        .getByRole("status")
        .filter({ hasText: "已保存反馈" })
        .waitFor();
      await assertRetained(page.getByLabel("问题描述", { exact: true }), "");
      const feedbackRequests = (await data(page)).requests.filter(
        (row) => row.method === "POST" && row.path === "/api/system/feedback",
      );
      assert.equal(
        feedbackRequests[0].body.requestId,
        feedbackRequests[1].body.requestId,
      );
      assert.equal(
        feedbackRequests[1].body.attachments[0].name,
        "fixture-summary.txt",
      );
      run.flows.push(
        "feedback: failed submit preserves description/steps/file and retry operation id; success clears fields",
      );

      await open("apps");
      const appCard = page.locator("article", { hasText: "示例网页" });
      await appCard.waitFor();
      await appCard.getByText(/运行中 · 持有链接的人 · 有效期至/).waitFor();
      await appCard.getByRole("button", { name: "复制链接" }).click();
      await appCard.getByRole("button", { name: "已复制" }).waitFor();
      await appCard.getByRole("button", { name: "停用", exact: true }).click();
      await appCard.getByText(/已停用/).waitFor();
      await appCard.getByRole("button", { name: "启用", exact: true }).click();
      await appCard.getByText(/运行中/).waitFor();
      await appCard.getByRole("button", { name: "删除", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "删除", exact: true })
        .click();
      await appCard.waitFor({ state: "detached" });
      assert.equal((await data(page)).apps.length, 0);
      await recordShot(page, browserName + "-published-pages");
      run.flows.push(
        "apps: lists published pages with scope and expiry; copy-link, disable/enable and confirmed delete all round-trip",
      );

      await open("acp");
      await page.getByText("管理员提供的 ACP 引擎", { exact: true }).click();
      await page.getByLabel("API Key（必填）").fill("fixture-key-only");
      await failNext(
        page,
        "/api/runtime/v1/acp-catalog/approved/credentials",
        "PUT",
      );
      await page.getByRole("button", { name: "保存连接信息" }).click();
      await page.getByRole("alert").waitFor();
      await assertRetained(
        page.getByLabel("API Key（必填）"),
        "fixture-key-only",
      );
      await page.getByRole("button", { name: "保存连接信息" }).click();
      await page.getByRole("status").waitFor();
      await assertRetained(page.getByLabel("API Key（必填）"), "");
      assert.equal((await data(page)).catalog.ready, true);
      run.flows.push(
        "ACP employee: failed save preserves password input; successful save clears it and shows readiness",
      );
      await open("acp-admin");
      await failNext(page, "/api/portal/admin/acp-catalog/approved", "PATCH");
      await page.getByRole("button", { name: "停用", exact: true }).click();
      await page.getByRole("alert").waitFor();
      assert.equal((await data(page)).catalog.enabled, true);
      await page.getByRole("button", { name: "停用", exact: true }).click();
      await page.getByRole("button", { name: "启用此版本" }).waitFor();
      await recordShot(page, browserName + "-acp-admin");
      run.flows.push(
        "ACP administrator: rejected change preserves enabled version; retry disables it",
      );

      await open("teams");
      await page.getByLabel("团队名称", { exact: true }).fill("浏览器验收团队");
      await page.getByLabel("负责人名称").fill("组长");
      await page.getByLabel("团队项目").selectOption("fixture-project");
      await page.getByLabel("负责人助手").selectOption("approved-preset");
      await page.getByRole("button", { name: "创建团队" }).click();
      await page.getByRole("button", { name: "交给团队自主完成" }).click();
      await page.getByLabel("团队操作内容").fill("整理验收结果并给出结论");
      await failNext(page, "/api/runtime/v1/teams/team-created/runs");
      await page.getByRole("button", { name: "确认", exact: true }).click();
      await page.getByRole("alert").waitFor();
      await assertRetained(
        page.getByLabel("团队操作内容"),
        "整理验收结果并给出结论",
      );
      await page.getByRole("button", { name: "确认", exact: true }).click();
      await page.getByText("团队协作中", { exact: true }).waitFor();
      const teamState = await data(page);
      assert.equal(teamState.teams[0].members[0].acpCatalogId, "approved");
      const attempts = teamState.requests.filter(
        (row) => row.path.endsWith("/runs") && row.method === "POST",
      );
      assert.equal(attempts[0].body.operationId, attempts[1].body.operationId);
      await recordShot(page, browserName + "-teams");
      run.flows.push(
        "teams: ACP lead identity propagates; failed run preserves goal and operation id, retry starts run",
      );

      await open("once");
      await page.getByLabel("任务名称").fill("一次性浏览器验收");
      await page.getByLabel("执行助手").selectOption("approved-preset");
      await page.getByLabel("所属项目").selectOption("fixture-project");
      await page.getByLabel("任务内容").fill("输出隔离验收结果");
      await page.getByLabel("执行频率").selectOption("once");
      await page.getByLabel(/^执行时间（/).fill("2099-01-01T09:30");
      await failNext(page, "/api/runtime/v1/automations");
      await page.getByRole("button", { name: "创建任务", exact: true }).click();
      await page.getByRole("alert").waitFor();
      await assertRetained(page.getByLabel("任务名称"), "一次性浏览器验收");
      await assertRetained(page.getByLabel(/^执行时间（/), "2099-01-01T09:30");
      await recordShot(page, browserName + "-once-error");
      await page.getByRole("button", { name: "创建任务", exact: true }).click();
      await page.getByText("一次性浏览器验收", { exact: true }).waitFor();
      const once = (await data(page)).automations[0];
      assert.equal(once.schedule.kind, "once");
      assert.equal(once.schedule.at, "2099-01-01T01:30:00.000Z");
      assert.equal(once.acpCatalogId, "approved");
      run.flows.push(
        "once: failed create preserves fields/local time; successful payload uses UTC instant and ACP catalog id",
      );
      console.log(
        `${browserName}: ${run.flows.length} functional flows checked`,
      );
      await desktop.close();
    }

    for (const [orientation, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["portrait", { width: 430, height: 932 }],
      ["landscape", { width: 932, height: 430 }],
    ]) {
      const touch = orientation !== "desktop";
      const context = await browser.newContext({
        viewport,
        isMobile: touch,
        hasTouch: touch,
        deviceScaleFactor: touch ? 3 : 1,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === base
          ? route.continue()
          : route.abort(),
      );
      const mobile = await context.newPage();
      activePage = mobile;
      mobile.on("pageerror", (error) => run.errors.push(error.message));
      for (const theme of ["light", "dark"])
        for (const [font, minimum] of [
          ["13", 16],
          ["14", 16],
          ["16", 18],
          ["18", 20],
        ]) {
          if (onceLayout && font !== "18") continue;
          await mobile.emulateMedia({ colorScheme: theme });
          for (const screen of [
            "feedback",
            "apps",
            "acp",
            "acp-admin",
            "feedback-admin",
            "teams",
            "once",
          ]) {
            if (onceLayout && screen !== "once") continue;
            await mobile.request.post(base + "/__fixture/reset");
            await mobile.goto(
              base + "?screen=" + screen + "&font=" + font + "&theme=" + theme,
            );
            await mobile
              .locator("main > section, main > details")
              .first()
              .waitFor();
            if (screen === "acp") {
              await mobile
                .getByText("管理员提供的 ACP 引擎", { exact: true })
                .click();
              await mobile.getByLabel("API Key（必填）").waitFor();
            }
            if (screen === "acp-admin")
              await mobile
                .getByRole("button", { name: "停用", exact: true })
                .waitFor();
            if (screen === "feedback")
              await mobile
                .getByRole("button", { name: "预览诊断摘要" })
                .click();
            if (screen === "apps")
              await mobile
                .getByRole("button", { name: "复制链接" })
                .waitFor();
            if (screen === "feedback-admin")
              await mobile.locator("details > summary").first().click();
            if (screen === "once")
              await mobile.getByLabel("执行频率").selectOption("once");
            const media = await mobile.evaluate(() => ({
              coarse: matchMedia("(any-pointer: coarse)").matches,
              fine: matchMedia("(any-pointer: fine)").matches,
              touchPoints: navigator.maxTouchPoints,
              innerWidth,
              font: document.documentElement.dataset.workagentFontSize,
            }));
            assert(
              !touch || media.coarse,
              `Touch emulation was lost: ${JSON.stringify(media)}`,
            );
            const controls = mobile.locator(editable);
            const rows = [];
            for (let i = 0; i < (await controls.count()); i++) {
              const control = controls.nth(i);
              if (!(await control.isVisible())) continue;
              const before = await control.evaluate((node) => ({
                tag: node.tagName,
                label:
                  node.getAttribute("aria-label") ||
                  node.labels?.[0]?.textContent?.trim() ||
                  node.name,
                size: parseFloat(getComputedStyle(node).fontSize),
                width: node.getBoundingClientRect().width,
                height: node.getBoundingClientRect().height,
                lineHeight: getComputedStyle(node).lineHeight,
                contentHeight:
                  node.clientHeight -
                  parseFloat(getComputedStyle(node).paddingTop) -
                  parseFloat(getComputedStyle(node).paddingBottom),
              }));
              await control.focus();
              const focused = await control.evaluate((node) =>
                parseFloat(getComputedStyle(node).fontSize),
              );
              if (onceLayout && before.tag === "SELECT")
                assert(
                  before.contentHeight + 1 >= parseFloat(before.lineHeight),
                  `Select text clipped: ${JSON.stringify(before)}`,
                );
              assert(
                before.size > 0 &&
                  focused > 0 &&
                  (!touch || (before.size >= minimum && focused >= minimum)),
                `${browserName}/${orientation}/${theme}/${font}/${screen}: ${JSON.stringify({ before, focused, minimum, media })}`,
              );
              rows.push({ ...before, focused });
            }
            const overflow = await mobile.evaluate(
              () => document.documentElement.scrollWidth - innerWidth,
            );
            assert(
              overflow <= 2,
              `${browserName}/${orientation}/${font}/${screen}: horizontal overflow ${overflow}`,
            );
            const viewportMeta = await mobile
              .locator('meta[name="viewport"]')
              .getAttribute("content");
            assert(
              !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(
                viewportMeta,
              ),
            );
            run.typography.push({
              orientation,
              viewport,
              theme,
              font,
              minimum,
              screen,
              media,
              rows,
              horizontalOverflow: overflow,
            });
            if (
              onceLayout ||
              (font === "13" && theme === "light") ||
              (font === "18" && theme === "dark")
            )
              await recordShot(
                mobile,
                `${browserName}-${orientation}-${theme}-${font}-${screen}`,
              );
          }
        }
      await context.close();
      console.log(`${browserName}: ${orientation} typography complete`);
    }
    assert.deepEqual(run.errors, []);
    await browser.close();
    activeBrowser = undefined;
  }
  report.passed = report.browserRuns.every((run) => !run.findings?.length);
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  report.lastRequests = state.requests;
  if (activePage && !activePage.isClosed()) {
    report.lastFrames = activePage
      .frames()
      .map((frame) => ({ name: frame.name(), url: frame.url() }));
    await activePage
      .screenshot({ path: join(output, "failure.png"), fullPage: true })
      .catch(() => {});
    await writeFile(join(output, "failure.html"), await activePage.content());
  }
  throw error;
} finally {
  await activeBrowser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(
    join(output, "README.txt"),
    "Run: node scripts/smoke-parity-ui-fixture.mjs\nLocal fake API only. No production data or real engine acceptance.\nPhysical iPhone keyboard zoom remains unverified.\nSee report.json and screenshots.\n",
  );
}
console.log(
  `Isolated browser smoke ${report.passed ? "passed" : "found failures"}: ${report.browserRuns.map((run) => `${run.browserName} ${run.flows?.length || 0} flows / ${run.typography?.length || 0} typography cases`).join(", ")}. Evidence: ${output}`,
);
if (!report.passed) process.exitCode = 1;
