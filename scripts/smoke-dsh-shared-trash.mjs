import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import {
  login,
  baseURL,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";

// Only authentication and shell/read requests reach the configured server.
// All shared APIs and every subsequent non-GET API request use memory fixtures.
requireSmokeEnvironment();
const out = resolve(
  process.env.WORKAGENT_TRASH_EVIDENCE_DIR || ".cache/shared-trash-ui/browser",
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const projectA = "trash-fixture-project-a",
  projectB = "trash-fixture-project-b";
const projects = [
  { id: projectA, name: "品牌体验升级", currentRole: "owner" },
  { id: projectB, name: "季度研究资料", currentRole: "member" },
];
const conversations = projects.map((project, index) => ({
  id: `trash-fixture-discussion-${index}`,
  project_id: project.id,
  name: "项目讨论",
  state: "idle",
}));
const makeEntry = (id, name, path, days, extra = {}) => ({
  id,
  name,
  path,
  kind: "file",
  size: 17800,
  deletedAt: new Date(Date.now() - (7 - days) * 86400000).toISOString(),
  expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
  ...extra,
});
const trash = new Map([
  [
    projectA,
    [
      makeEntry(
        "restore-file",
        "品牌设计说明.md",
        "设计资料/品牌设计说明.md",
        6,
      ),
      makeEntry(
        "conflict-file",
        "首页设计稿.fig",
        "设计资料/首页设计稿.fig",
        3,
        { size: 17238420 },
      ),
      makeEntry("delete-folder", "旧版交付文件", "归档/旧版交付文件", 0.6, {
        kind: "directory",
        size: 44211200,
      }),
      makeEntry("legacy-file", "会议纪要.txt", "会议纪要.txt", 2, {
        legacy: true,
        size: 8600,
      }),
    ],
  ],
  [
    projectB,
    [
      makeEntry(
        "project-b-file",
        "另一项目私有记录.txt",
        "研究/另一项目私有记录.txt",
        4,
      ),
    ],
  ],
]);
const files = new Map(
  projects.map((project) => [
    project.id,
    [{ name: "项目简报.md", path: "项目简报.md", kind: "file", size: 2470 }],
  ]),
);
const report = {
  mode: "authenticated shell with isolated shared API fixtures and blocked API writes",
  checks: [],
  errors: [],
  requests: [],
  blockedWrites: [],
  layouts: [],
};
let failNextList = false;
page.on("pageerror", (error) => report.errors.push(error.message));
await page.addInitScript(() => {
  const mode = sessionStorage.getItem("trash-smoke-theme") || "porcelain";
  localStorage.setItem(
    "workagent.appearance.v1",
    JSON.stringify({ mode, daylight: "porcelain" }),
  );
  localStorage.setItem("workagent.files.open", "false");
});
for (const name of ["client.js", "tokens.css"])
  await page.route(`**/plugins/@workagent/dsh-client/${name}*`, (route) =>
    route.fulfill({
      path: resolve(
        process.env.WORKAGENT_TRASH_CLIENT_DIR ||
          "packages/dsh-client-workagent",
        name,
      ),
      contentType: name.endsWith("css") ? "text/css" : "text/javascript",
    }),
  );
await page.route(/\/api\//, async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    path = url.pathname,
    method = request.method();
  if (!path.startsWith("/api/portal/shared-")) {
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      report.blockedWrites.push({ method, path });
      return route.fulfill({ json: {} });
    }
    if (path.endsWith("/completion-notifications"))
      return route.fulfill({
        json: { enabled: false, targets: [], sessionSettings: {} },
      });
    return route.continue();
  }
  report.requests.push({ method, path });
  if (path.endsWith("shared-events"))
    return route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    });
  let data = {},
    status = 200;
  if (path.endsWith("shared-projects")) data = { projects };
  else if (path.endsWith("shared-conversations")) data = { conversations };
  else if (path.endsWith("shared-invites")) data = { invites: [] };
  else if (path.endsWith("shared-messages")) data = { messages: [] };
  else if (path.endsWith("/members"))
    data = { members: [{ userId: 1, displayName: "林悦", role: "owner" }] };
  else if (path.endsWith("/assistants") || path.endsWith("/assistant-options"))
    data = { assistants: [] };
  else if (path.includes("/shared-workspaces/")) {
    const match = path.match(/\/shared-workspaces\/([^/]+)(\/.*)/),
      project = match?.[1],
      suffix = match?.[2];
    assert(trash.has(project), "unknown fixture project");
    if (suffix === "/files") data = files.get(project);
    else if (suffix === "/move" || suffix === "/uploads") data = [];
    else if (suffix === "/trash" && method === "GET") {
      if (failNextList) {
        failNextList = false;
        status = 503;
        data = { error: "回收站暂时不可用，请重试。" };
      } else
        data = {
          entries: trash.get(project),
          usedBytes: 8.4 * 1024 ** 3,
          projectUsedBytes: trash
            .get(project)
            .reduce((total, entry) => total + entry.size, 0),
          limitBytes: 60 * 1024 ** 3,
          retentionDays: 7,
        };
    } else {
      const item = suffix.match(/^\/trash\/([^/]+)(\/restore)?$/);
      const entry =
        item && trash.get(project).find((row) => row.id === item[1]);
      if (!entry) {
        status = 404;
        data = { error: "file_not_found" };
      } else if (item[2] && method === "POST") {
        if (entry.id === "conflict-file") {
          status = 409;
          data = { error: "file_exists" };
        } else {
          trash.set(
            project,
            trash.get(project).filter((row) => row.id !== entry.id),
          );
          files
            .get(project)
            .push({ ...entry, path: entry.legacy ? entry.name : entry.path });
          data = entry;
        }
      } else if (!item[2] && method === "DELETE")
        trash.set(
          project,
          trash.get(project).filter((row) => row.id !== entry.id),
        );
      else throw new Error(`Unhandled fixture ${method} ${path}`);
    }
  } else {
    status = 404;
    data = { error: "unhandled_fixture_route" };
    report.errors.push(`${method} ${path}`);
  }
  return route.fulfill({ status, json: data });
});
const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
};
const panel = () =>
  page.getByRole("complementary", { name: "项目文件侧栏", exact: true });
const openProject = async (project = projectA) => {
  const conversation = conversations.find((row) => row.project_id === project);
  await page.goto(
    `${baseURL}/?frontend=dsh&workagent=shared&project=${project}&discussion=${conversation.id}`,
  );
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await panel()
    .getByRole("button", { name: "打开项目回收站", exact: true })
    .waitFor();
};
const enterTrash = async () => {
  await panel()
    .getByRole("button", { name: "打开项目回收站", exact: true })
    .click();
  await panel().getByLabel("当前项目回收站文件", { exact: true }).waitFor();
  await panel().getByText("所有成员共享回收空间", { exact: true }).waitFor();
};
const menu = (name) =>
  panel()
    .getByRole("button", { name: `操作 ${name}`, exact: true })
    .click();
const setTheme = async (theme) =>
  page.evaluate(
    (value) => sessionStorage.setItem("trash-smoke-theme", value),
    theme,
  );
const checkLayout = async (label) => {
  const layout = await panel().evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const names = ["上传文件", "新建文件", "新建文件夹", "打开项目回收站"];
    const buttons = names.map((name) => {
      const button = node.querySelector(`button[aria-label="${name}"]`),
        box = button.getBoundingClientRect(),
        svg = button.querySelector("svg").getBoundingClientRect();
      return {
        name,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        svgWidth: svg.width,
        svgHeight: svg.height,
      };
    });
    return {
      viewport: innerWidth,
      x: rect.x,
      width: rect.width,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      buttons,
    };
  });
  assert(
    layout.x >= -1 && layout.x + layout.width <= layout.viewport + 1,
    `${label} panel clipped`,
  );
  for (const button of layout.buttons)
    assert.equal(button.width, 30, `${label} ${button.name} width`);
  for (const button of layout.buttons)
    assert.equal(button.height, 30, `${label} ${button.name} height`);
  for (const button of layout.buttons)
    assert.equal(button.svgWidth, 17, `${label} ${button.name} icon`);
  const gaps = layout.buttons
    .slice(1)
    .map(
      (button, i) => button.x - layout.buttons[i].x - layout.buttons[i].width,
    );
  assert.deepEqual(gaps, [4, 4, 4], `${label} toolbar spacing`);
  assert(
    layout.scrollWidth <= layout.clientWidth + 1,
    `${label} horizontal overflow`,
  );
  report.layouts.push({ label, ...layout, gaps });
};
try {
  // login uses APIRequestContext, which is outside page routing, and is the sole POST reaching production.
  await login(page);
  for (const [theme, width, height, label] of [
    ["porcelain", 1440, 1000, "desktop-light"],
    ["graphite", 1440, 1000, "desktop-dark"],
    ["porcelain", 390, 844, "mobile-light"],
    ["graphite", 390, 844, "mobile-dark"],
  ]) {
    await setTheme(theme);
    await page.setViewportSize({ width, height });
    await openProject();
    if (width < 760) {
      const toggle = page.locator(".hHd-Xa_toggle");
      const expanded = page.locator(".hHd-Xa_root:not(.hHd-Xa_collapsed)");
      if (await expanded.count()) await toggle.click();
    }
    await checkLayout(label);
    await shot(`${label}-files`);
    await enterTrash();
    assert.equal(
      await panel().getByText("另一项目私有记录.txt", { exact: true }).count(),
      0,
    );
    assert.equal(
      await panel().getByText("品牌设计说明.md", { exact: true }).count(),
      1,
    );
    await shot(`${label}-trash`);
  }
  report.checks.push(
    "desktop/mobile light/dark toolbar size and spacing",
    "project-only recycle view",
    "shared 60 GB capacity and 7 day FIFO explanation",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setTheme("porcelain");
  await openProject();
  await enterTrash();
  await menu("首页设计稿.fig");
  await panel().getByRole("button", { name: "恢复", exact: true }).click();
  assert.equal(
    report.requests.filter((request) => request.method === "POST").length,
    0,
  );
  await panel().getByRole("button", { name: "确认恢复", exact: true }).click();
  await panel()
    .getByText(
      "原位置已有同名文件。请先在项目文件中重命名或移走同名文件，再恢复。",
      { exact: true },
    )
    .waitFor();
  await shot("restore-conflict");
  assert(trash.get(projectA).some((row) => row.id === "conflict-file"));
  await panel().getByRole("button", { name: "取消", exact: true }).click();
  await menu("品牌设计说明.md");
  await panel().getByRole("button", { name: "恢复", exact: true }).click();
  await panel().getByRole("button", { name: "确认恢复", exact: true }).click();
  await panel().getByText("已恢复“品牌设计说明.md”", { exact: true }).waitFor();
  await menu("旧版交付文件");
  await panel().getByRole("button", { name: "永久删除", exact: true }).click();
  await panel()
    .getByRole("form", { name: "永久删除文件", exact: true })
    .waitFor();
  await shot("permanent-delete-confirmation");
  await panel().getByRole("button", { name: "永久删除", exact: true }).click();
  await panel()
    .getByText("已永久删除“旧版交付文件”", { exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "返回项目文件", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "品牌设计说明.md", exact: true })
    .waitFor();
  report.checks.push(
    "restore confirmation and non-overwriting conflict",
    "confirmed directory permanent deletion",
    "return refresh shows restored file",
  );
  await openProject(projectB);
  await enterTrash();
  await panel().getByText("另一项目私有记录.txt", { exact: true }).waitFor();
  assert.equal(
    await panel().getByText("首页设计稿.fig", { exact: true }).count(),
    0,
  );
  await shot("project-b-isolation");
  await menu("另一项目私有记录.txt");
  await panel().getByRole("button", { name: "恢复", exact: true }).click();
  await panel().getByRole("button", { name: "确认恢复", exact: true }).click();
  await panel().getByText("本项目回收站为空", { exact: true }).waitFor();
  await shot("project-b-empty");
  report.checks.push(
    "cross-project navigation isolates entries",
    "empty state after restore",
  );
  await openProject();
  failNextList = true;
  await panel()
    .getByRole("button", { name: "打开项目回收站", exact: true })
    .click();
  await panel().getByRole("button", { name: "重新加载", exact: true }).click();
  await panel().getByText("首页设计稿.fig", { exact: true }).waitFor();
  report.checks.push("load failure retries in place");
  assert.deepEqual(report.errors, []);
  report.passed = true;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(`Shared trash UI smoke passed (${report.checks.length} checks)`);
} catch (error) {
  await shot("failure");
  await writeFile(
    `${out}/failure.json`,
    JSON.stringify({ ...report, message: error.message }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
