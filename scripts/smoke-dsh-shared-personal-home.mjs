import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { baseURL, requireSmokeEnvironment } from "./smoke-dsh-helpers.mjs";

// The authenticated DSH shell is real. All workspace/session resources and API
// writes below are browser-local fixtures; no task or project data is created.
requireSmokeEnvironment();
const out = resolve(
  process.env.WORKAGENT_PERSONAL_EVIDENCE_DIR ||
    ".cache/shared-personal-home/browser",
);
const candidate = resolve(
  process.env.WORKAGENT_PERSONAL_CLIENT_DIR || "packages/dsh-client-workagent",
);
const management = process.env.WORKAGENT_PERSONAL_MANAGEMENT === "1";
const kimiPresetId = management ? "builtin-kimi" : "personal-home-kimi";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const report = {
  mode: "authenticated DSH shell with local candidate assets and isolated API fixtures",
  checks: [],
  errors: [],
  requests: [],
  blockedWrites: [],
  typography: [],
  screenshots: [],
  management: [],
  physicalDeviceAcceptance:
    "Not performed; desktop emulation does not establish iPhone focus zoom behavior.",
};
const project = {
  id: "personal-home-fixture-project",
  name: "品牌体验升级",
  currentRole: "owner",
};
const presets = [
  { id: "builtin-general", name: "Codex", engine: "codex" },
  { id: kimiPresetId, name: "Kimi", engine: "kimi" },
  { id: "personal-home-research", name: "研究助手", engine: "harness" },
].map((row) => ({
  ...row,
  enabled: true,
  source: "builtin",
  description: "",
  workspacePolicy: "optional",
  skillIds: [],
  mcpServerIds: [],
  toolAllowlist: [],
  approvalPolicy: "on_risk",
}));
const models = ["codex", "kimi", "harness"].map((engine) => ({
  engine,
  models: ["standard", "pro"].map((name, index) => ({
    id: `fixture-${engine}-${name}`,
    name: `${engine === "kimi" ? "Kimi" : engine === "codex" ? "Codex" : "研究"} ${name === "pro" ? "Pro" : "Standard"}`,
    isDefault: index === 0,
    defaultReasoning: "low",
    reasoning: [
      { id: "low", name: "低" },
      { id: "high", name: "高" },
    ],
  })),
}));
let currentPage;
const shot = async (page, name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
};
const activeSidebar = (page) =>
  page.locator(".hHd-Xa_root:not(.hHd-Xa_collapsed):not(.hHd-Xa_fading)");
async function toggleSidebar(page) {
  const button = page
    .getByRole("button", {
      name: /Toggle sidebar|Toggle Sidebar|切换侧边栏|打开侧栏|展开侧栏|收起侧栏|Open sidebar|Close sidebar|Collapse sidebar|Expand sidebar/i,
    })
    .first();
  if (await button.count()) return button.click();
  const fallback = page
    .locator(
      ".hHd-Xa_toggle, .wSkVaW_sidebarToggle, button[title*='sidebar' i]",
    )
    .first();
  await fallback.click();
}
async function fixturePage(viewport, theme) {
  const page = await browser.newPage({ viewport });
  currentPage = page;
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(45000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.addInitScript(
    ({ theme }) => {
      localStorage.setItem(
        "workagent.appearance.v1",
        JSON.stringify({ mode: theme, daylight: "porcelain" }),
      );
      localStorage.setItem("workagent.files.open", "false");
      localStorage.setItem("workagent.hero.agent", "builtin-general");
      localStorage.setItem("workagent.font-size", "14");
      localStorage.removeItem("workagent.model-defaults.v1");
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
  const sessions = [],
    conversations = [
      {
        id: "personal-home-discussion",
        project_id: project.id,
        name: "项目讨论",
        state: "idle",
        kind: "discussion",
        pinned: false,
      },
    ];
  const attempts = [],
    creations = [],
    pointers = [];
  const states = new Map();
  const mutations = [];
  const deletedSessions = new Set();
  const rpc = (route, req, value) =>
    route.fulfill({
      json: {
        type: "server-response",
        rpcId: req.rpcId,
        result: { ok: true, value },
      },
    });
  await page.route(/\/api\//, async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const write = !["GET", "HEAD", "OPTIONS"].includes(method);
    const body = write ? req.postDataJSON() : null;
    report.requests.push({ method, path });
    if (path.startsWith("/api/session.")) {
      if (path === "/api/session.list")
        return rpc(route, body, {
          items: sessions.map((row) => ({
            sessionId: row.id,
            title: row.title,
            cwd: "shared fixture",
            activity: row.activity,
          })),
          hasMore: false,
        });
      if (path === "/api/session.history") {
        const state = states.get(body.payload.sessionId);
        if (!state && deletedSessions.has(body.payload.sessionId))
          return route.fulfill({
            json: {
              type: "server-response",
              rpcId: body.rpcId,
              result: {
                ok: false,
                error: {
                  code: "session_not_found",
                  message: "session_not_found",
                },
              },
            },
          });
        assert(state, "history only reads fixture sessions");
        return rpc(route, body, {
          events: [],
          hasMore: false,
          projections: {
            asOfSeq: state.sequence,
            values: { nativeSession: state },
          },
        });
      }
      if (path === "/api/session.models") {
        const row = sessions.find((row) => row.id === body.payload.sessionId);
        return rpc(route, body, {
          routable: true,
          current: { provider: row.engine, model: row.modelId },
          groups: [],
          failures: [],
        });
      }
      if (path === "/api/session.prompt") {
        attempts.push({
          sessionId: body.payload.sessionId,
          messageId: body.rpcId,
          content: body.payload.content[0].text,
          transport: "native",
        });
        const state = states.get(body.payload.sessionId);
        state.sequence++;
        state.messages.push({
          id: body.rpcId,
          sessionId: body.payload.sessionId,
          role: "user",
          text: body.payload.content[0].text,
          createdAt: new Date().toISOString(),
        });
        return rpc(route, body, { accepted: true });
      }
      report.blockedWrites.push({ method, path });
      return rpc(route, body, {});
    }
    if (path.startsWith("/api/portal/shared-")) {
      if (path.endsWith("shared-events"))
        return route.fulfill({
          contentType: "text/event-stream",
          body: ": ready\n\n",
        });
      if (path.endsWith("shared-projects"))
        return route.fulfill({ json: { projects: [project] } });
      if (path.endsWith("shared-conversations")) {
        if (method === "PATCH" || method === "DELETE") {
          mutations.push({ method, path, body });
          const index = conversations.findIndex(
            (row) => row.id === body.conversation_id,
          );
          assert(
            index >= 0,
            "management only addresses fixture conversation pointers",
          );
          if (method === "DELETE") {
            conversations.splice(index, 1);
            return route.fulfill({ json: {} });
          }
          const { conversation_id: _id, ...fields } = body;
          Object.assign(conversations[index], fields);
          return route.fulfill({
            json: { conversation: conversations[index] },
          });
        }
        if (method === "POST") {
          pointers.push(body);
          const conversation = {
            ...body,
            id: `personal-home-pointer-${pointers.length}`,
            creator_user_id: 1,
            state: "idle",
            pinned: false,
          };
          conversations.push(conversation);
          return route.fulfill({ json: { conversation } });
        }
        return route.fulfill({ json: { conversations } });
      }
      if (path.endsWith("shared-invites"))
        return route.fulfill({ json: { invites: [] } });
      if (path.endsWith("shared-messages"))
        return route.fulfill({ json: { messages: [] } });
      if (path.endsWith("/members"))
        return route.fulfill({
          json: {
            members: [{ userId: 1, displayName: "林悦", role: "owner" }],
          },
        });
      if (path.endsWith("/assistants") || path.endsWith("/assistant-options"))
        return route.fulfill({ json: { assistants: [] } });
      if (path.includes("/shared-workspaces/")) {
        assert(path.startsWith(`/api/portal/shared-workspaces/${project.id}/`));
        if (path.endsWith("/files"))
          return route.fulfill({
            json: [
              {
                name: "品牌简报.md",
                path: "品牌简报.md",
                kind: "file",
                size: 2470,
              },
            ],
          });
        if (path.endsWith("/content"))
          return route.fulfill({
            contentType: "text/plain",
            body: "# 品牌简报\n当前项目的共享文件。",
          });
        if (path.endsWith("/trash"))
          return route.fulfill({
            json: {
              entries: [
                {
                  id: "personal-home-trash",
                  name: "旧版设计.md",
                  path: "旧版设计.md",
                  kind: "file",
                  size: 1200,
                  deletedAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
                },
              ],
              usedBytes: 3 * 1024 ** 3,
              projectUsedBytes: 1200,
              limitBytes: 60 * 1024 ** 3,
              retentionDays: 7,
            },
          });
        if (
          path.endsWith("/uploads") ||
          path.endsWith("/move") ||
          path.endsWith("/assets")
        )
          return route.fulfill({ json: [] });
      }
      report.errors.push(`Unhandled shared fixture: ${method} ${path}`);
      return route.fulfill({
        status: 404,
        json: { error: "fixture_not_found" },
      });
    }
    if (path.startsWith("/api/runtime/v1/")) {
      const suffix = path.slice("/api/runtime/v1".length);
      if (suffix === "/presets") return route.fulfill({ json: presets });
      if (suffix === "/model-options") return route.fulfill({ json: models });
      if (suffix === "/sessions") {
        if (write) {
          creations.push(body);
          const row = {
            ...body,
            id: `personal-home-session-${sessions.length + 1}`,
            workspaceId: `shared:${body.sharedProjectId}`,
            activity: { state: "idle" },
            createdAt: new Date().toISOString(),
            preset: {
              resolvedSnapshot: presets.find(
                (preset) => preset.id === body.presetId,
              ),
            },
          };
          sessions.push(row);
          states.set(row.id, {
            sequence: 1000000,
            metadata: { ...row, queue: [] },
            messages: [],
            processes: {},
            tools: {},
            draft: "",
            activity: { state: "idle" },
          });
          return route.fulfill({ json: row });
        }
        return route.fulfill({ json: sessions });
      }
      const match = suffix.match(/^\/sessions\/([^/]+)(\/.*)?$/);
      if (match) {
        const row = sessions.find((row) => row.id === match[1]);
        if (!row && deletedSessions.has(match[1]))
          return route.fulfill({
            status: 404,
            json: { error: "session_not_found" },
          });
        assert(row, "only fixture runtime sessions are accessed");
        if (!match[2] && method === "DELETE") {
          mutations.push({ method, path });
          sessions.splice(sessions.indexOf(row), 1);
          states.delete(row.id);
          deletedSessions.add(row.id);
          return route.fulfill({ json: {} });
        }
        if (!match[2] && method === "PATCH") {
          mutations.push({ method, path, body });
          Object.assign(row, body);
          Object.assign(states.get(row.id).metadata, body);
          return route.fulfill({ json: row });
        }
        if (!match[2]) return route.fulfill({ json: row });
        if (match[2] === "/turns") {
          attempts.push({ ...body, sessionId: row.id, transport: "runtime" });
          return route.fulfill({
            status: 503,
            json: { error: "fixture_first_turn_unavailable" },
          });
        }
        if (match[2] === "/events")
          return route.fulfill({
            contentType: "text/event-stream",
            body: ": ready\n\n",
          });
        return route.fulfill({ json: [] });
      }
      if (suffix === "/completion-notifications")
        return route.fulfill({
          json: { enabled: false, targets: [], sessionSettings: {} },
        });
      return route.fulfill({ json: [] });
    }
    if (write) {
      report.blockedWrites.push({ method, path });
      return route.fulfill({ json: {} });
    }
    return route.continue();
  });
  const authentication = await page.request.post(`${baseURL}/api/auth/login`, {
    data: {
      username: process.env.WORKAGENT_SMOKE_USERNAME,
      password: process.env.WORKAGENT_SMOKE_PASSWORD,
    },
    headers: { Origin: new URL(baseURL).origin },
  });
  assert(authentication.ok(), "authenticated production shell login succeeds");
  await page.goto(`${baseURL}/?frontend=dsh`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("radiogroup", { name: "选择 Agent", exact: true })
    .waitFor();
  return {
    page,
    attempts,
    creations,
    pointers,
    sessions,
    conversations,
    states,
    mutations,
  };
}

async function verifyManagement(fixture, label, viewport) {
  const { page, conversations, sessions, states, mutations } = fixture;
  const sessionId = new URL(page.url()).searchParams.get("session");
  const pointer = conversations.find(
    (row) => row.runtime_session_id === sessionId,
  );
  const originalName = pointer.name;
  if (!(await activeSidebar(page).isVisible())) await toggleSidebar(page);
  const sidebar = activeSidebar(page);
  const taskRow = (name) =>
    sidebar.locator(".workagent-sidebar-session").filter({
      has: page.getByRole("button", {
        name: `个人任务操作 ${name}`,
        exact: true,
      }),
    });
  await taskRow(originalName)
    .locator(".workagent-engine-mark.is-kimi")
    .waitFor();
  assert.equal(
    await taskRow(originalName)
      .locator(".workagent-engine-mark.is-harness")
      .count(),
    0,
  );
  await shot(page, `${label}-management-avatar`);
  const rowNames = () =>
    sidebar
      .locator(".workagent-sidebar-project-sessions .workagent-session-title")
      .allTextContents();
  assert.deepEqual(await rowNames(), ["项目讨论", originalName]);
  const openMenu = async (name) => {
    await sidebar
      .getByRole("button", { name: `个人任务操作 ${name}`, exact: true })
      .click();
    const menu = page.getByRole("dialog", { name: "对话操作", exact: true });
    await menu.waitFor();
    assert(
      await menu.evaluate((node) => node.closest("dialog")?.matches(":modal")),
      "conversation menu is in the native top layer",
    );
    return menu;
  };
  let menu = await openMenu(originalName);
  await shot(page, `${label}-management-menu`);
  await menu.getByRole("button", { name: "置顶对话", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  await page.waitForFunction(
    (name) =>
      document.querySelector(
        ".workagent-sidebar-project-sessions .workagent-session-title",
      )?.textContent === name,
    originalName,
  );
  assert.equal(pointer.pinned, true);
  assert.deepEqual(await rowNames(), [originalName, "项目讨论"]);
  menu = await openMenu(originalName);
  await menu.getByRole("button", { name: "取消置顶", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  assert.equal(pointer.pinned, false);
  assert.deepEqual(await rowNames(), ["项目讨论", originalName]);
  menu = await openMenu(originalName);
  await menu.getByRole("button", { name: "管理对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理对话", exact: true });
  const input = dialog.getByRole("textbox", { name: "对话名称", exact: true });
  await input.waitFor();
  const dimensions = await input.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return {
      fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
      inputBounds: rect.toJSON(),
      topLayer: node.closest("dialog")?.matches(":modal"),
      clickable: hit === node || node.contains(hit),
      viewportScale: window.visualViewport?.scale,
    };
  });
  assert(
    dimensions.topLayer && dimensions.clickable,
    "rename input stays above the sidebar and can be tapped",
  );
  if (viewport.width <= 760)
    assert(
      dimensions.fontSize >= 16,
      "standard mobile rename input has a 16px minimum",
    );
  const renamed = "品牌升级 · 我的设计任务";
  await input.fill(renamed);
  await shot(page, `${label}-management-rename`);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await taskRow(renamed).waitFor();
  await page.waitForFunction(
    (name) =>
      document.querySelector(".workagent-conversation-title strong")
        ?.textContent === name,
    renamed,
  );
  assert.equal(pointer.name, renamed);
  await shot(page, `${label}-management-renamed-sidebar`);
  await toggleSidebar(page);
  await shot(page, `${label}-management-renamed-conversation`);
  await toggleSidebar(page);
  const confirmDelete = async () => {
    const menu = await openMenu(renamed);
    await menu.getByRole("button", { name: "管理对话", exact: true }).click();
    await page
      .getByRole("dialog", { name: "管理对话", exact: true })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "确认删除",
      exact: true,
    });
    await confirmation.waitFor();
    await confirmation.getByText(/项目文件会保留/).waitFor();
    return confirmation;
  };
  const messagesBefore = states.get(sessionId).messages.length;
  assert(messagesBefore > 0, "the deleted fixture contains a message");
  let confirmation = await confirmDelete();
  await shot(page, `${label}-management-delete-confirmation`);
  const deletionsBefore = mutations.filter(
    (row) => row.method === "DELETE",
  ).length;
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(
    mutations.filter((row) => row.method === "DELETE").length,
    deletionsBefore,
  );
  assert(sessions.some((row) => row.id === sessionId));
  assert(conversations.includes(pointer));
  assert.equal(states.get(sessionId).messages.length, messagesBefore);
  confirmation = await confirmDelete();
  await confirmation.getByRole("button", { name: "删除", exact: true }).click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get("workagent") === "shared" &&
      url.searchParams.get("project") === project.id &&
      !url.searchParams.has("session"),
  );
  assert(!sessions.some((row) => row.id === sessionId));
  assert(!conversations.includes(pointer));
  assert(!states.has(sessionId));
  assert.equal(
    await page
      .getByRole("button", { name: `个人任务操作 ${renamed}`, exact: true })
      .count(),
    0,
  );
  await shot(page, `${label}-management-deleted`);
  report.management.push({
    label,
    protocol: "legacy",
    ...dimensions,
    messagesDeleted: messagesBefore,
    mutations: mutations.map((row) => ({
      method: row.method,
      path: row.path,
      body: row.body,
    })),
  });
  report.checks.push(
    `${label}: real Kimi session avatar; pin order and unpin; shared management dialog rename updates sidebar/header; cancel preserves task/messages; confirmed legacy deletion removes session/pointer/messages and returns to project`,
  );
}

try {
  for (const [label, viewport, theme] of [
    ["desktop-light", { width: 1440, height: 1000 }, "porcelain"],
    ["desktop-dark", { width: 1440, height: 1000 }, "graphite"],
    ["mobile-light", { width: 390, height: 844 }, "porcelain"],
    ["mobile-dark", { width: 390, height: 844 }, "graphite"],
  ].filter(
    ([label]) =>
      !process.env.WORKAGENT_PERSONAL_LAYOUTS ||
      process.env.WORKAGENT_PERSONAL_LAYOUTS.split(",").includes(label),
  )) {
    const fixture = await fixturePage(viewport, theme);
    const { page, attempts, creations, pointers } = fixture;
    await page.goto(
      `${baseURL}/?frontend=dsh&workagent=shared&project=${project.id}&discussion=personal-home-discussion`,
    );
    if (!(await activeSidebar(page).isVisible())) await toggleSidebar(page);
    await page
      .getByRole("button", {
        name: `在 ${project.name} 中新建讨论`,
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", { name: "新建讨论", exact: true });
    await dialog
      .getByRole("button", { name: "新建个人任务", exact: true })
      .waitFor();
    assert.equal(await dialog.getByRole("checkbox").count(), 0);
    assert.equal(
      await dialog
        .getByRole("textbox", { name: "名称", exact: true })
        .inputValue(),
      "",
    );
    await shot(page, `${label}-entry`);
    await dialog
      .getByRole("button", { name: "新建个人任务", exact: true })
      .click();
    await page.waitForURL((url) => url.searchParams.get("personal") === "new");
    const picker = page.getByRole("radiogroup", {
      name: "选择 Agent",
      exact: true,
    });
    await picker.getByRole("radio", { name: "Kimi", exact: true }).waitFor();
    await page
      .getByRole("textbox", { name: "输入消息", exact: true })
      .waitFor();
    await page
      .locator(".workagent-shared-project-name")
      .filter({ hasText: project.name })
      .waitFor();
    await page.waitForFunction(() => !document.querySelector(".hHd-Xa_fading"));
    assert.equal(
      await activeSidebar(page).count(),
      0,
      "entry collapses collaboration sidebar",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "收起文件侧栏", exact: true })
        .count(),
      0,
      "entry leaves file sidebar closed",
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "个人项目", exact: true })
        .count(),
      0,
      "shared folder cannot switch to personal",
    );
    await shot(page, `${label}-home`);
    await toggleSidebar(page);
    await page
      .getByRole("button", {
        name: `在 ${project.name} 中新建讨论`,
        exact: true,
      })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("workagent"), "shared");
    await shot(page, `${label}-collaboration-sidebar`);
    await toggleSidebar(page);
    await page
      .getByRole("button", { name: "打开文件侧栏", exact: true })
      .click();
    const panel = page.getByRole("complementary", {
      name: "项目文件侧栏",
      exact: true,
    });
    await panel
      .getByRole("button", { name: "品牌简报.md", exact: true })
      .waitFor();
    await panel
      .getByRole("button", { name: "打开项目回收站", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "查看 旧版设计.md 的回收信息", exact: true })
      .waitFor();
    await shot(page, `${label}-trash`);
    await panel
      .getByRole("button", { name: "关闭文件侧栏", exact: true })
      .first()
      .click();
    await picker.getByRole("radio", { name: "Kimi", exact: true }).click();
    const settings = page.getByRole("button", {
      name: "模型与权限设置",
      exact: true,
    });
    if (viewport.width < 761) {
      await page.evaluate(() => {
        window.__personalSmokePointer = [];
        for (const name of ["pointerdown", "focusin", "pointerup", "click"])
          document.addEventListener(
            name,
            (event) => {
              const button = document.querySelector(
                ".workagent-composer-settings",
              );
              window.__personalSmokePointer.push({
                type: event.type,
                target:
                  event.target.className?.baseVal ?? event.target.className,
                label: event.target.getAttribute?.("aria-label"),
                button: button?.getBoundingClientRect().toJSON(),
                expanded: button?.getAttribute("aria-expanded"),
              });
            },
            { capture: true },
          );
      });
      await settings.click();
      report.mobileSettingsPointer = await page.evaluate(
        () => window.__personalSmokePointer,
      );
      assert.equal(
        await settings.getAttribute("aria-expanded"),
        "true",
        "mobile model settings opens",
      );
      await shot(page, `${label}-model-settings`);
    }
    await page
      .getByRole("combobox", { name: "模型", exact: true })
      .selectOption("fixture-kimi-pro");
    await page
      .getByRole("combobox", { name: "思考级别", exact: true })
      .selectOption("high");
    if (
      (await settings.isVisible()) &&
      (await settings.getAttribute("aria-expanded")) === "true"
    )
      await settings.click();
    const content = "请根据当前共享项目的品牌简报，整理下一阶段的设计任务。";
    await page
      .getByRole("textbox", { name: "输入消息", exact: true })
      .fill(content);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.has("session"));
    assert.equal(creations.length, 1);
    assert.equal(creations[0].sharedProjectId, project.id);
    assert.equal(creations[0].presetId, kimiPresetId);
    assert.equal(creations[0].engine, "kimi");
    assert.equal(creations[0].modelId, "fixture-kimi-pro");
    assert.equal(creations[0].thinkingEffort, "high");
    assert.equal(creations[0].workspace, undefined);
    assert.equal(pointers.length, 1);
    assert.equal(pointers[0].kind, "personal_task");
    assert.equal(pointers[0].project_id, project.id);
    assert.equal(
      pointers[0].runtime_session_id,
      new URL(page.url()).searchParams.get("session"),
    );
    const failedId = attempts[0].messageId;
    const bubble = page.locator(`[data-message-id="${failedId}"]`);
    await bubble
      .getByRole("button", { name: "重试发送", exact: true })
      .waitFor();
    await shot(page, `${label}-failed-first-turn`);
    await bubble.getByRole("button", { name: "重试发送", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('[data-delivery-status="failed"]'),
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].messageId, failedId);
    assert.equal(attempts[1].content, content);
    assert.equal(await bubble.count(), 1);
    assert.equal(new URL(page.url()).searchParams.get("workagent"), "shared");
    await shot(page, `${label}-retry`);
    report.checks.push(
      `${label}: button entry without name; shared ordinary hero; sidebar persistence; fixed files and trash; selected Agent/model; private pointer; exact-ID first-turn retry`,
    );
    if (label === "mobile-light" && !management) {
      for (const size of [13, 14, 16, 18]) {
        await page.evaluate((value) => {
          localStorage.setItem("workagent.font-size", String(value));
          document.documentElement.style.setProperty(
            "--workagent-font-scale",
            String(value / 14),
          );
        }, size);
        for (const view of [
          { width: 390, height: 844 },
          { width: 844, height: 390 },
        ]) {
          await page.setViewportSize(view);
          const computed = await page
            .getByRole("textbox", { name: "继续对话", exact: true })
            .evaluate((node) => ({
              fontSize: getComputedStyle(node).fontSize,
              width: node.getBoundingClientRect().width,
              viewport: window.innerWidth,
              viewportScale: window.visualViewport?.scale,
              overflow: document.documentElement.scrollWidth > innerWidth,
            }));
          report.typography.push({
            setting: size,
            orientation: view.width < view.height ? "portrait" : "landscape",
            expectedMinimum: { 13: 16, 14: 16, 16: 18, 18: 20 }[size],
            meetsMinimum:
              Number.parseFloat(computed.fontSize) >=
              { 13: 16, 14: 16, 16: 18, 18: 20 }[size],
            ...computed,
          });
        }
      }
    }
    if (management) await verifyManagement(fixture, label, viewport);
    await page.close();
    currentPage = null;
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  console.log(
    `Shared personal task home browser smoke passed (${report.checks.length} layout flows)`,
  );
} catch (error) {
  report.status = "failed";
  report.failure = error.stack;
  if (currentPage) {
    await shot(currentPage, "failure").catch(() => {});
    report.visibleControls = await currentPage
      .locator("button")
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getBoundingClientRect().width)
          .map((node) => ({
            label: node.getAttribute("aria-label"),
            expanded: node.getAttribute("aria-expanded"),
            title: node.title,
            text: node.innerText.slice(0, 60),
            className: node.className,
          })),
      )
      .catch(() => []);
    report.layout = await currentPage
      .locator(
        ".workagent-overlay, .workagent-overlay-content, .workagent-conversation-workspace, .workagent-runtime-conversation, .workagent-message-list, .workagent-message, .workagent-conversation-composer",
      )
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          className: node.className,
          bounds: node.getBoundingClientRect().toJSON(),
          display: getComputedStyle(node).display,
          position: getComputedStyle(node).position,
          height: getComputedStyle(node).height,
          minHeight: getComputedStyle(node).minHeight,
          overflow: getComputedStyle(node).overflow,
          scrollHeight: node.scrollHeight,
          scrollTop: node.scrollTop,
        })),
      )
      .catch(() => []);
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
