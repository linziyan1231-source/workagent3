import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit } from "playwright";
import { WorkspaceStore } from "../harness-bundle/dist/workspace-store.js";
import { WorkspaceController } from "../harness-bundle/dist/workspace-api.js";
import {
  baseURL,
  login,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";

// Production is used only for authenticated shell reads. Every workspace request
// is served by the real controller against isolated local fixture storage.
requireSmokeEnvironment();
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = join(process.env.WORKAGENT_SMOKE_EVIDENCE_DIR, engine);
await mkdir(out, { recursive: true });
const fixture = await mkdtemp(join(tmpdir(), "wa-moves-browser-"));
const store = new WorkspaceStore(
  join(fixture, "projects"),
  join(fixture, "home"),
);
const project = store.create("文书归类验证");
const paper = store.write(
  project.id,
  "港科finance人工写.txt",
  Buffer.from("original finance paper"),
);
store.write(project.id, "说明.txt", Buffer.from("notes"));
store.write(project.id, "编辑.txt", Buffer.from("before"));
store.mkdir(project.id, "历史参考文件");
store.registerArtifact(project.id, "session-moves", paper.path);
const report = { engine, checks: [], errors: [] };
let busy = false;
store.moves.busy = () => busy;
let handler;
const disposers = [];
new WorkspaceController(
  {
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    },
    webServer: {
      register: (route) => {
        handler = route.handler;
        return () => {};
      },
    },
  },
  "fixture-file-moves-token",
  store,
  () => project.id,
);
const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500);
    res.end(String(error));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureURL = `http://127.0.0.1:${server.address().port}`;
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error) => report.errors.push(error.message));
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "true"),
);
const session = {
  id: "session-moves",
  title: "文书归类验证",
  engine: "harness",
  workspaceId: project.id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  activity: { state: "idle" },
};
try {
  const candidate = process.env.WORKAGENT_UPLOAD_CANDIDATE;
  if (candidate)
    for (const file of ["client.js", "tokens.css"])
      await page.route(`**/plugins/@workagent/dsh-client/${file}*`, (route) =>
        route.fulfill({
          path: join(candidate, file),
          contentType: file.endsWith("css") ? "text/css" : "text/javascript",
        }),
      );
  await page.route(
    /\/api\/runtime\/v1\/workspaces(?:\/|$|\?)/,
    async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      const response = await route.fetch({
        url: fixtureURL + url.pathname.replace("/api/runtime", "") + url.search,
        headers: {
          ...req.headers(),
          authorization: "Bearer fixture-file-moves-token",
        },
      });
      await route.fulfill({ response });
    },
  );
  await page.route(/\/api\/runtime\/v1\/sessions(?:\/|$|\?)/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": fixture\n\n",
      });
    const data = path.endsWith("/sessions")
      ? [session]
      : path.endsWith("/messages")
        ? [
            {
              id: "old-link",
              role: "assistant",
              text: `[历史文书](${encodeURI(paper.path)}?workagentFileId=${paper.fileId})`,
              createdAt: session.createdAt,
            },
          ]
        : /\/(queue|tools|approvals|processes|models)$/.test(path)
          ? []
          : session;
    return route.fulfill({ json: data });
  });
  await page.route(
    "**/api/runtime/v1/interactions?sessionId=session-moves",
    (route) => route.fulfill({ json: [] }),
  );
  await page.route("**/api/session.models", (route) => {
    const req = route.request().postDataJSON();
    return route.fulfill({
      json: {
        type: "server-response",
        rpcId: req.rpcId,
        result: {
          ok: true,
          value: {
            current: { provider: "fixture", model: "fixture" },
            groups: [],
          },
        },
      },
    });
  });
  await login(page);
  if (!candidate) {
    const liveProjects = await page.request.get(`${baseURL}/api/runtime/v1/workspaces`);
    assert.equal(liveProjects.status(), 200);
    const existing = (await liveProjects.json()).find(row => row.scope !== "team");
    if (existing) {
      const moves = await page.request.get(`${baseURL}/api/runtime/v1/workspaces/${encodeURIComponent(existing.id)}/move`);
      assert.equal(moves.status(), 200); assert(Array.isArray(await moves.json()));
    }
    report.checks.push("deployed authenticated move API is available (read-only)");
  }

  await page
    .getByRole("combobox", { name: "个人项目", exact: true })
    .selectOption(project.id);
  const panel = page.locator(".workagent-files-panel");
  await panel.getByRole("button", { name: paper.name, exact: true }).waitFor();
  await drag(paper.path, "历史参考文件", true);
  await page.waitForFunction(() =>
    document.querySelector(
      '[data-file-path="历史参考文件/港科finance人工写.txt"]',
    ),
  );
  assert.equal(
    store.locate(project.id, paper.path, paper.fileId).path,
    "历史参考文件/" + paper.path,
  );
  assert.equal(
    store.listAssets(project.id, session.id)[0].path,
    "历史参考文件/" + paper.path,
  );
  report.checks.push(
    "drag highlights target and moves real file with stable identity and artifact update",
  );
  await panel.getByRole("button", { name: "撤销移动", exact: true }).click();
  await panel.locator(`[data-file-path="${paper.path}"]`).waitFor();
  report.checks.push("undo restores root file");
  await panel
    .getByRole("checkbox", { name: `选择 ${paper.name}`, exact: true })
    .check();
  await panel
    .getByRole("checkbox", { name: "选择 说明.txt", exact: true })
    .check();
  await panel.getByRole("button", { name: "移动到…", exact: true }).click();
  let chooser = panel.getByRole("dialog", { name: "移动到文件夹" });
  await chooser
    .getByRole("button", { name: "📁 历史参考文件", exact: true })
    .click();
  await chooser.getByLabel("新文件夹名称").fill("初稿");
  await chooser
    .getByRole("button", { name: "新建文件夹", exact: true })
    .click();
  await chooser.getByRole("button", { name: "初稿", exact: true }).waitFor();
  await page.screenshot({ path: join(out, "folder-picker.png") });
  await chooser
    .getByRole("button", { name: "移动到这里", exact: true })
    .click();
  await panel
    .locator('[data-file-path="历史参考文件/初稿/说明.txt"]')
    .waitFor();
  report.checks.push(
    "multi-select chooser creates nested folder without entering paths",
  );
  await drag("历史参考文件/初稿/说明.txt", "");
  await panel.locator('[data-file-path="说明.txt"]').waitFor();
  report.checks.push("drag back to root");
  store.write(
    project.id,
    "历史参考文件/说明.txt",
    Buffer.from("keep original"),
  );
  await drag("说明.txt", "历史参考文件");
  await panel.getByRole("button", { name: "保留两份", exact: true }).click();
  await panel.locator('[data-file-path="历史参考文件/说明 (1).txt"]').waitFor();
  assert.equal(
    store.read(project.id, "历史参考文件/说明.txt").toString(),
    "keep original",
  );
  report.checks.push("same-name collision keeps both files");
  busy = true;
  await drag("历史参考文件/说明 (1).txt", "");
  await panel
    .getByText("已安排移动，等待任务结束或文件编辑保存。", { exact: true })
    .waitFor();
  assert.equal(
    store.read(project.id, "历史参考文件/说明 (1).txt").toString(),
    "notes",
  );
  busy = false;
  await panel.locator('[data-file-path="说明 (1).txt"]').waitFor();
  report.checks.push("running-agent move waits, then completes automatically");
  await panel.getByRole("button", { name: "编辑.txt", exact: true }).click();
  await panel.getByRole("button", { name: "编辑文件", exact: true }).click();
  await panel
    .locator(".workagent-text-editor textarea")
    .fill("saved before move");
  await page.waitForTimeout(200);
  const queued = store.moves.request(project.id, [
    { source: "编辑.txt", destination: "历史参考文件/编辑.txt" },
  ]);
  assert.equal(queued.state, "queued");
  await panel.getByRole("button", { name: "保存文件", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".workagent-file-preview-pane header strong")
        ?.textContent === "编辑.txt",
  );
  await page.waitForTimeout(2200);
  assert.equal(
    store.read(project.id, "历史参考文件/编辑.txt").toString(),
    "saved before move",
  );
  report.checks.push(
    "dirty editor holds cross-tab move until saved; preview follows new location",
  );
  await panel
    .getByRole("button", { name: "返回文件列表", exact: true })
    .click();
  await page.evaluate(id => { history.pushState(null, "", `/?frontend=dsh&session=${id}`); window.dispatchEvent(new PopStateEvent("popstate")); }, session.id);
  await page.getByRole("link", { name: "历史文书", exact: true }).click();
  await page.getByText("original finance paper", { exact: true }).waitFor();
  report.checks.push("historical chat link opens moved file after navigation");
  await page.screenshot({ path: join(out, "history-preview.png") });
  await panel
    .getByRole("button", { name: "返回文件列表", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel
    .getByRole("button", { name: "历史参考文件", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "操作 编辑.txt", exact: true })
    .click();
  await panel.getByRole("button", { name: "移动到…", exact: true }).click();
  await panel.getByRole("dialog", { name: "移动到文件夹" }).waitFor();
  await page.screenshot({ path: join(out, "mobile-picker.png") });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  report.checks.push("mobile folder chooser fits viewport");
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  await page.screenshot({ path: join(out, "failure.png") });
  throw error;
} finally {
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  for (const dispose of disposers) dispose();
  await new Promise((resolve) => server.close(resolve));
}
async function drag(source, destination, inspect = false) {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator(`[data-file-path="${source}"]`)
    .dispatchEvent("dragstart", { dataTransfer: transfer });
  const target = page.locator(`[data-move-target="${destination}"]`);
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  if (inspect) {
    await target.evaluate((el) => {
      if (!el.classList.contains("is-move-target"))
        throw new Error("Missing target highlight");
    });
    await page.screenshot({ path: join(out, "drag-highlight.png") });
  }
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}
