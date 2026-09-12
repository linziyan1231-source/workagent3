import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { baseURL, requireSmokeEnvironment } from "./smoke-dsh-helpers.mjs";

// Use the authenticated shell, with every task/project and every API write
// isolated in browser fixtures. Authentication is the sole real mutation.
requireSmokeEnvironment();
assert(
  process.env.WORKAGENT_PIN_CLIENT_DIR,
  "an immutable candidate is required",
);
const candidate = resolve(process.env.WORKAGENT_PIN_CLIENT_DIR);
const out = resolve(
  process.env.WORKAGENT_PIN_EVIDENCE_DIR || ".cache/sidebar-pins/browser",
);
await mkdir(out, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  screenshots: [],
  requests: [],
  blockedWrites: [],
  measurements: [],
};
const browser = await chromium.launch();
let currentPage;
const workspaces = [
  { id: "pin-private-project", name: "我的品牌项目", scope: "personal" },
  { id: "pin-team-project", name: "团队资料项目", scope: "team" },
];
const project = {
  id: "pin-shared-project",
  name: "协作品牌升级",
  currentRole: "owner",
};
const preset = {
  id: "builtin-kimi",
  name: "Kimi",
  engine: "kimi",
  enabled: true,
  source: "builtin",
  workspacePolicy: "optional",
  skillIds: [],
  mcpServerIds: [],
  toolAllowlist: [],
  approvalPolicy: "on_risk",
};
const sessions = [
  {
    id: "pin-ordinary-task",
    title: "普通任务基准",
    workspaceId: workspaces[0].id,
  },
  {
    id: "pin-shared-task",
    title: "品牌方案草稿",
    workspaceId: `shared:${project.id}`,
  },
].map((row) => ({
  ...row,
  engine: "kimi",
  modelId: "fixture-kimi",
  presetId: preset.id,
  preset: { resolvedSnapshot: preset },
  activity: { state: "idle" },
  createdAt: "2026-09-12T06:00:00Z",
  updatedAt: "2026-09-12T06:00:00Z",
}));
const activeSidebar = (page) =>
  page.locator(".hHd-Xa_root:not(.hHd-Xa_collapsed):not(.hHd-Xa_fading)");
async function showSidebar(page) {
  await page
    .locator(".workagent-sidebar-browser .workagent-sidebar-project-row")
    .first()
    .waitFor({ state: "attached" });
  await page
    .locator(".hHd-Xa_root.hHd-Xa_fading")
    .waitFor({ state: "detached" });
  if (await page.locator(".hHd-Xa_root.hHd-Xa_collapsed").count())
    await page.locator(".hHd-Xa_toggle").first().click();
  await activeSidebar(page).waitFor();
  await page.waitForTimeout(300);
}
async function screenshot(page, name) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
}
async function fixturePage(viewport, theme) {
  const page = await browser.newPage({
    viewport,
    isMobile: viewport.width < 760,
    hasTouch: viewport.width < 760,
  });
  currentPage = page;
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(45000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.addInitScript(
    ({ theme, workspaces, project, sessions }) => {
      localStorage.setItem(
        "workagent.appearance.v1",
        JSON.stringify({ mode: theme, daylight: "porcelain" }),
      );
      localStorage.setItem("workagent.font-size", "14");
      localStorage.setItem("workagent.files.open", "false");
      localStorage.setItem(
        "workagent.session-pins.v1",
        JSON.stringify([sessions[0].id]),
      );
      localStorage.setItem(
        "workagent.project-pins.v1",
        JSON.stringify(workspaces.map((row) => row.id)),
      );
      localStorage.setItem(
        "workagent.shared-project-pins.v1",
        JSON.stringify([project.id]),
      );
    },
    { theme, workspaces, project, sessions },
  );
  for (const name of ["client.js", "tokens.css"])
    await page.route(`**/plugins/@workagent/dsh-client/${name}*`, (route) =>
      route.fulfill({
        path: resolve(candidate, name),
        contentType: name.endsWith("css") ? "text/css" : "text/javascript",
      }),
    );
  const conversations = [
    {
      id: "pin-discussion",
      project_id: project.id,
      name: "项目讨论",
      kind: "discussion",
      state: "idle",
      pinned: true,
    },
    {
      id: "pin-personal-pointer",
      project_id: project.id,
      name: sessions[1].title,
      kind: "personal_task",
      runtime_session_id: sessions[1].id,
      creator_user_id: 1,
      state: "idle",
      pinned: true,
    },
  ];
  await page.route(/\/api\//, async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    const write = !["GET", "HEAD", "OPTIONS"].includes(method);
    report.requests.push({ method, path });
    const json = (value) => route.fulfill({ json: value });
    const body = write && req.postData() ? req.postDataJSON() : null;
    if (path.startsWith("/api/session.")) {
      let value = {};
      if (path.endsWith(".list")) value = { items: [], hasMore: false };
      if (path.endsWith(".models"))
        value = {
          routable: true,
          current: { provider: "kimi", model: "fixture-kimi" },
          groups: [],
          failures: [],
        };
      if (path.endsWith(".history")) {
        const row = sessions.find((row) => row.id === body.payload.sessionId);
        assert(row, "history only reads seeded sessions");
        value = {
          events: [],
          hasMore: false,
          projections: {
            asOfSeq: 1,
            values: {
              nativeSession: {
                sequence: 1,
                metadata: { ...row, queue: [] },
                messages: [],
                tools: {},
                processes: {},
                draft: "",
                activity: row.activity,
              },
            },
          },
        };
      }
      return json({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value },
      });
    }
    if (path.startsWith("/api/portal/shared-")) {
      if (path.endsWith("shared-events"))
        return route.fulfill({
          contentType: "text/event-stream",
          body: ": ready\n\n",
        });
      if (path.endsWith("shared-projects"))
        return json({ projects: [project] });
      if (path.endsWith("shared-conversations")) {
        if (method === "PATCH") {
          const row = conversations.find(
            (row) => row.id === body.conversation_id,
          );
          assert(
            row && typeof body.pinned === "boolean",
            "only fixture pin mutations are expected",
          );
          row.pinned = body.pinned;
          return json({ conversation: row });
        }
        assert.equal(
          method,
          "GET",
          "no creation/deletion expected in pin smoke",
        );
        return json({ conversations });
      }
      if (path.endsWith("shared-invites")) return json({ invites: [] });
      if (path.endsWith("shared-messages")) return json({ messages: [] });
      if (path.endsWith("/members"))
        return json({
          members: [{ userId: 1, displayName: "林悦", role: "owner" }],
        });
      if (path.endsWith("/assistants") || path.endsWith("/assistant-options"))
        return json({ assistants: [] });
      return json({});
    }
    if (path.startsWith("/api/runtime/v1/")) {
      const suffix = path.slice("/api/runtime/v1".length);
      if (suffix === "/sessions") return json(sessions);
      if (suffix === "/workspaces") return json(workspaces);
      if (suffix === "/presets") return json([preset]);
      if (suffix === "/model-options")
        return json([
          {
            engine: "kimi",
            models: [{ id: "fixture-kimi", name: "Kimi", isDefault: true }],
          },
        ]);
      if (suffix === "/completion-notifications")
        return json({ enabled: false, targets: [], sessionSettings: {} });
      const match = suffix.match(/^\/sessions\/([^/]+)$/);
      if (match) return json(sessions.find((row) => row.id === match[1]));
      if (suffix.endsWith("/events"))
        return route.fulfill({
          contentType: "text/event-stream",
          body: ": ready\n\n",
        });
      return json([]);
    }
    if (write) {
      report.blockedWrites.push({ method, path });
      return json({});
    }
    return route.continue();
  });
  const login = await page.request.post(`${baseURL}/api/auth/login`, {
    data: {
      username: process.env.WORKAGENT_SMOKE_USERNAME,
      password: process.env.WORKAGENT_SMOKE_PASSWORD,
    },
    headers: { Origin: new URL(baseURL).origin },
  });
  assert(login.ok(), "authenticated shell login succeeds");
  return { page, conversations };
}
async function pinShape(locator) {
  await locator.waitFor();
  return locator.evaluate((svg) => {
    const style = getComputedStyle(svg),
      box = svg.getBoundingClientRect();
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      width: style.width,
      height: style.height,
      viewBox: svg.getAttribute("viewBox"),
      color: style.color,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      paths: [...svg.querySelectorAll("path")].map((path) => ({
        d: path.getAttribute("d"),
        fill: getComputedStyle(path).fill,
        stroke: getComputedStyle(path).stroke,
      })),
    };
  });
}
function comparable({ box, ...shape }) {
  return shape;
}
async function matchingPin(locator, baseline, label) {
  const shape = await pinShape(locator);
  assert.deepEqual(
    comparable(shape),
    comparable(baseline),
    `${label}: exact ordinary shape, dimensions, fill and stroke`,
  );
  assert.equal(shape.box.width, 14);
  assert.equal(shape.box.height, 14);
  return shape;
}
async function alignedBadge(row, pin) {
  return row.locator(".workagent-sidebar-meta").evaluate((meta, pin) => {
    const badge = meta
      .querySelector(".workagent-badge, small")
      .getBoundingClientRect();
    const styles = getComputedStyle(meta);
    return {
      badge: {
        x: badge.x,
        y: badge.y,
        width: badge.width,
        height: badge.height,
      },
      pin: pin.box,
      centerDifference: Math.abs(
        badge.y + badge.height / 2 - pin.box.y - pin.box.height / 2,
      ),
      gap: pin.box.x - badge.right,
      display: styles.display,
      wrap: styles.flexWrap,
    };
  }, pin);
}
async function projectToggle(page, name, expected) {
  await activeSidebar(page)
    .getByRole("button", { name: `项目操作 ${name}`, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: expected ? "置顶项目" : "取消置顶",
      exact: true,
    })
    .click();
}
const layouts = [
  ["mobile-light", { width: 430, height: 932 }, "porcelain"],
  ["desktop-light", { width: 1440, height: 1000 }, "porcelain"],
  ["desktop-dark", { width: 1440, height: 1000 }, "graphite"],
  ["mobile-dark", { width: 430, height: 932 }, "graphite"],
].filter(
  ([name]) =>
    !process.env.WORKAGENT_PIN_LAYOUTS ||
    process.env.WORKAGENT_PIN_LAYOUTS.split(",").includes(name),
);
try {
  for (const [label, viewport, theme] of layouts) {
    const { page, conversations } = await fixturePage(viewport, theme);
    await page.goto(`${baseURL}/?frontend=dsh`, {
      waitUntil: "domcontentloaded",
    });
    await showSidebar(page);
    assert.equal(
      await page.locator("body").getAttribute("data-workagent-theme"),
      theme,
    );
    const ordinaryAction = activeSidebar(page).getByRole("button", {
      name: "取消置顶 普通任务基准",
      exact: true,
    });
    const baseline = await pinShape(ordinaryAction.locator("svg"));
    assert.equal(
      baseline.paths[0].fill,
      baseline.color,
      "ordinary pin is solid",
    );
    assert.equal(baseline.paths[1].fill, "none", "pin stem keeps its stroke");
    const measurement = { label, baseline, projects: [] };
    for (const project of workspaces) {
      const row = activeSidebar(page)
        .locator(".workagent-sidebar-project-row")
        .filter({
          has: page.getByRole("button", {
            name: `项目操作 ${project.name}`,
            exact: true,
          }),
        });
      const pin = await matchingPin(
        row.locator(".workagent-sidebar-meta .workagent-sidebar-pin"),
        baseline,
        project.name,
      );
      const data = { name: project.name, pin };
      if (project.scope === "team") {
        data.alignment = await alignedBadge(row, pin);
        assert(
          data.alignment.centerDifference < 0.1 && data.alignment.gap === 8,
        );
      }
      measurement.projects.push(data);
    }
    await screenshot(page, `${label}-ordinary-and-project-pins`);
    await ordinaryAction.click();
    const unpinned = await pinShape(
      activeSidebar(page)
        .getByRole("button", { name: "置顶 普通任务基准", exact: true })
        .locator("svg"),
    );
    assert.equal(unpinned.paths[0].fill, "none");
    await activeSidebar(page)
      .getByRole("button", { name: "置顶 普通任务基准", exact: true })
      .click();
    await projectToggle(page, workspaces[0].name, false);
    await projectToggle(page, workspaces[0].name, true);
    await page.goto(
      `${baseURL}/?frontend=dsh&workagent=shared&project=${project.id}&discussion=pin-discussion`,
      { waitUntil: "domcontentloaded" },
    );
    await showSidebar(page);
    const sharedProjectRow = activeSidebar(page)
      .locator(".workagent-sidebar-project-row")
      .filter({
        has: page.getByRole("button", {
          name: `项目操作 ${project.name}`,
          exact: true,
        }),
      });
    measurement.sharedProject = await matchingPin(
      sharedProjectRow.locator(
        ".workagent-sidebar-meta .workagent-sidebar-pin",
      ),
      baseline,
      "collaborative project",
    );
    const personalRow = activeSidebar(page)
      .locator(".workagent-sidebar-session")
      .filter({
        has: page.getByRole("button", {
          name: `个人任务操作 ${sessions[1].title}`,
          exact: true,
        }),
      });
    await personalRow.locator(".workagent-engine-mark.is-kimi").waitFor();
    measurement.personalTask = await matchingPin(
      personalRow.locator(".workagent-sidebar-meta .workagent-sidebar-pin"),
      baseline,
      "collaborative personal task",
    );
    measurement.alignment = await alignedBadge(
      personalRow,
      measurement.personalTask,
    );
    assert(
      measurement.alignment.centerDifference < 0.1,
      "personal badge and pin share the same vertical center",
    );
    assert.equal(
      measurement.alignment.gap,
      8,
      "pin sits 8px to the right of personal badge",
    );
    // A flex item blockifies inline-flex to computed flex.
    assert(["inline-flex", "flex"].includes(measurement.alignment.display));
    assert.equal(measurement.alignment.wrap, "nowrap");
    measurement.discussion = await matchingPin(
      activeSidebar(page)
        .getByRole("button", { name: "取消置顶 项目讨论", exact: true })
        .locator("svg"),
      baseline,
      "collaborative discussion",
    );
    await screenshot(page, `${label}-shared-pins`);
    await personalRow
      .getByRole("button", {
        name: `个人任务操作 ${sessions[1].title}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("dialog", { name: "对话操作" })
      .getByRole("button", { name: "取消置顶", exact: true })
      .click();
    await personalRow
      .locator(".workagent-sidebar-pin")
      .waitFor({ state: "detached" });
    assert.equal(
      await personalRow.locator(".workagent-badge").textContent(),
      "个人",
    );
    assert.equal(conversations[1].pinned, false);
    await screenshot(page, `${label}-shared-personal-unpinned`);
    await personalRow
      .getByRole("button", {
        name: `个人任务操作 ${sessions[1].title}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("dialog", { name: "对话操作" })
      .getByRole("button", { name: "置顶对话", exact: true })
      .click();
    await matchingPin(
      personalRow.locator(".workagent-sidebar-meta .workagent-sidebar-pin"),
      baseline,
      "repinned personal task",
    );
    await projectToggle(page, project.name, false);
    assert.equal(
      await sharedProjectRow.locator(".workagent-sidebar-pin").count(),
      0,
    );
    await projectToggle(page, project.name, true);
    await matchingPin(
      sharedProjectRow.locator(
        ".workagent-sidebar-meta .workagent-sidebar-pin",
      ),
      baseline,
      "repinned collaborative project",
    );
    await screenshot(page, `${label}-shared-repinned`);
    report.measurements.push(measurement);
    report.checks.push({
      label,
      status: "passed",
      exactPinReuse: true,
      horizontalPersonalBadge: true,
      unpinRepin: true,
    });
    await page.close();
    currentPage = null;
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.stack;
  if (currentPage) {
    await screenshot(currentPage, "failure").catch(() => {});
    report.visibleButtons = await currentPage
      .getByRole("button")
      .allTextContents()
      .catch(() => []);
  }
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
