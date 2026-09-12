import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  baseURL,
  withPage,
  openSettingsSection,
} from "./smoke-dsh-helpers.mjs";

// Project creation and account writes are intercepted. This smoke can safely
// verify the production shell without creating files or binding an IM account.
await withPage(async (page) => {
  const errors = [];
  const nativeRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/host\.pickDirectory|workspace\.create/.test(request.url()))
      nativeRequests.push(request.url());
  });
  const candidate = process.env.WORKAGENT_IM_CLIENT;
  if (candidate) {
    const body = await readFile(candidate, "utf8");
    await page.route(
      "**/plugins/@michengai/dsh-im-connect/client.js*",
      (route) => route.fulfill({ contentType: "text/javascript", body }),
    );
  }
  let liveProjectCount;
  if (!candidate) {
    const [projectsResponse, imResponse] = await Promise.all([
      page.request.get(`${baseURL}/api/runtime/v1/workspaces`),
      page.request.get(`${baseURL}/dsh-im-connect/api/projects`),
    ]);
    assert.equal(projectsResponse.status(), 200);
    assert.equal(imResponse.status(), 200);
    const projects = await projectsResponse.json();
    const im = await imResponse.json();
    assert.deepEqual(
      im.projects.filter((row) => row.id !== "default").map((row) => row.id),
      projects.map((row) => row.id),
    );
    assert(im.projects.every((row) => row.cwd && row.name));
    liveProjectCount = projects.length;
    const loadedProjects = page.waitForResponse(
      (response) =>
        response.url().endsWith("/dsh-im-connect/api/projects") &&
        response.status() === 200,
    );
    await openSettingsSection(page, "消息渠道");
    await loadedProjects;
    await page.locator(".ima-platform-add").first().click();
    const liveModal = page.locator(".ima-modal");
    await liveModal
      .getByRole("button", { name: "工作区", exact: true })
      .click();
    for (const row of im.projects)
      await liveModal
        .getByRole("menuitem", {
          name: row.name === "Personal workspace" ? "个人项目" : row.name,
          exact: true,
        })
        .waitFor();
    assert.equal(
      await liveModal.getByRole("menuitem").count(),
      im.projects.length + 1,
    );
    // Leave the unsaved modal by navigation; do not select or bind a real account.
    await page.goto(`${baseURL}/?frontend=dsh`);
  }
  const projects = [
    {
      id: "project-existing",
      name: "已有项目验收",
      cwd: "C:\\employee\\workspace\\已有项目验收",
    },
  ];
  let createCount = 0;
  let failCreation = false;
  let failListing = false;
  let failAfterCreate = false;
  let lastQrSettings;
  let savedAccount;
  const account = {
    id: "weixin-fixture",
    name: "已有账号验收",
    platform: "weixin",
    cwd: projects[0].cwd,
    permission: "workspace-write",
    privateAccess: "approved",
    assistant: { provider: "workagent-codex", model: "test" },
  };
  await page.route("**/dsh-im-connect/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const send = (data, status = 200) => route.fulfill({ status, json: data });
    if (path.endsWith("/projects"))
      return failListing
        ? send({ ok: false, error: "unavailable" }, 503)
        : send({ ok: true, projects });
    if (path.endsWith("/channels"))
      return send({
        ok: true,
        channels: [
          {
            id: "weixin",
            label: "微信",
            kind: "qr",
            fields: [],
            accounts: [account],
            total: 1,
            online: 0,
          },
        ],
        pending: [],
      });
    if (path.endsWith("/assistant"))
      return send({
        ok: true,
        providers: [],
        assistants: [],
        permissions: [],
        assistant: { provider: "workagent-codex", model: "test" },
        permission: "workspace-write",
        cwd: "",
      });
    if (path.endsWith("/qr/start")) {
      lastQrSettings = route.request().postDataJSON();
      return send({ ok: false, error: "验收已拦截绑定请求" });
    }
    if (path.endsWith("/accounts/weixin-fixture/settings")) {
      savedAccount = route.request().postDataJSON();
      account.cwd = savedAccount.cwd;
      return send({ ok: true });
    }
    if (route.request().method() !== "GET") return send({ ok: true });
    return route.continue();
  });
  await page.route("**/api/runtime/v1/workspaces", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: projects.map(({ id, name }) => ({
          id,
          name,
          scope: "personal",
          createdAt: "2026-09-11T00:00:00Z",
        })),
      });
    assert.equal(route.request().method(), "POST");
    createCount++;
    const body = route.request().postDataJSON();
    assert.equal(body.scope, "personal");
    assert.equal(typeof body.name, "string");
    assert.equal(body.path, undefined);
    if (failCreation)
      return route.fulfill({
        status: 409,
        json: { error: "workspace_directory_exists" },
      });
    const project = {
      id: `project-${createCount}`,
      name: body.name,
      cwd: `C:\\employee\\workspace\\${body.name}`,
    };
    projects.push(project);
    if (failAfterCreate) failListing = true;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({
      status: 201,
      json: { id: project.id, name: project.name, scope: "personal" },
    });
  });
  await page.goto(`${baseURL}/?frontend=dsh`);
  await openSettingsSection(page, "消息渠道");
  const openModal = async () => {
    await page.locator(".ima-platform-add").first().click();
    return page.locator(".ima-modal");
  };
  const add = async (modal) => {
    await modal.getByRole("button", { name: "工作区", exact: true }).click();
    await modal
      .getByRole("menuitem", {
        name: "添加工作区（新建项目文件）",
        exact: true,
      })
      .click();
    await modal
      .getByRole("textbox", { name: "项目名称", exact: true })
      .waitFor();
  };
  let modal = await openModal();
  await modal.getByRole("button", { name: "工作区", exact: true }).click();
  await modal
    .getByRole("menuitem", { name: "已有项目验收", exact: true })
    .click();
  assert.match(
    await modal
      .getByRole("button", { name: "工作区", exact: true })
      .innerText(),
    /已有项目验收/,
  );
  await add(modal);
  assert.equal(
    await modal.getByRole("button", { name: "创建", exact: true }).isDisabled(),
    true,
  );
  await modal
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("取消的项目");
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(createCount, 0);
  await add(modal);
  await modal
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("新建项目验收");
  await modal
    .getByRole("textbox", { name: "项目名称", exact: true })
    .press("Enter");
  await modal.locator(".ima-chip-dialog").waitFor({ state: "detached" });
  assert.equal(createCount, 1);
  assert.match(
    await modal
      .getByRole("button", { name: "工作区", exact: true })
      .innerText(),
    /新建项目验收/,
  );
  await modal.getByRole("button", { name: "生成二维码", exact: true }).click();
  await modal.getByText("验收已拦截绑定请求", { exact: true }).waitFor();
  assert.equal(lastQrSettings.settings.cwd, projects.at(-1).cwd);
  await add(modal);
  failCreation = true;
  await modal
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("重复项目");
  await modal.getByRole("button", { name: "创建", exact: true }).click();
  await modal
    .getByText("同名项目已存在，请选择已有项目或更换名称。", { exact: true })
    .waitFor();
  assert.equal(
    await modal
      .getByRole("textbox", { name: "项目名称", exact: true })
      .inputValue(),
    "重复项目",
  );
  failCreation = false;
  failAfterCreate = true;
  await modal
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("恢复列表项目");
  await modal.getByRole("button", { name: "创建", exact: true }).click();
  await modal
    .getByText("项目已创建，但列表加载失败。请重试，不会重复创建。", {
      exact: true,
    })
    .waitFor();
  const countBeforeRetry = createCount;
  failListing = false;
  failAfterCreate = false;
  await modal.getByRole("button", { name: "创建", exact: true }).click();
  await modal.locator(".ima-chip-dialog").waitFor({ state: "detached" });
  assert.equal(createCount, countBeforeRetry);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).waitFor();
  const closeFiles = page.getByRole("button", {
    name: "关闭文件侧栏",
    exact: true,
  });
  if (await closeFiles.isVisible()) await closeFiles.click();
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await add(modal);
  assert.equal(
    await modal.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    false,
  );
  const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "im-create-mobile.png"),
      fullPage: false,
    });
  }
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole("button", { name: /已有账号验收/ }).click();
  const inspector = page.locator(".ima-inspector");
  await inspector
    .getByRole("button", { name: "当前工作区", exact: true })
    .click();
  const savedResponse = page.waitForResponse((response) =>
    response.url().endsWith("/accounts/weixin-fixture/settings"),
  );
  await inspector
    .getByRole("menuitem", { name: "新建项目验收", exact: true })
    .click();
  await savedResponse;
  assert.equal(savedAccount.cwd, projects[1].cwd);
  failListing = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("button", { name: "重试加载项目", exact: true })
    .waitFor();
  failListing = false;
  await page.getByRole("button", { name: "重试加载项目", exact: true }).click();
  await page
    .getByRole("button", { name: "重试加载项目", exact: true })
    .waitFor({ state: "detached" });
  await page.goto(`${baseURL}/?frontend=dsh&workagent=workspaces`);
  await page.getByText("新建项目验收", { exact: true }).first().waitFor();
  await page.getByText("恢复列表项目", { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeRequests, []);
  const report = {
    passed: true,
    liveProjectCount,
    checks: [
      "existing-project-selection",
      "named-creation",
      "empty-and-cancel",
      "enter-submit",
      "selected-cwd-binding",
      "creation-error",
      "list-retry-without-duplicate",
      "mobile-form",
      "project-page-sync",
      "existing-account-project-save",
      "list-failure-retry",
      "no-native-directory-picker",
    ],
    createCount,
  };
  if (evidence)
    await writeFile(
      join(evidence, "im-workspaces-report.json"),
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report));
});
