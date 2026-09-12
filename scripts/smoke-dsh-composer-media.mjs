import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { login, baseURL } from "./smoke-dsh-helpers.mjs";

// Candidate visual/interaction checks use isolated in-memory API fixtures.
// Production supplies only the authenticated shell; all collaboration writes
// are intercepted. Backend transaction/ACL tests run independently in Go.
const out = resolve(
  process.env.WORKAGENT_COLLAB_EVIDENCE_DIR ||
    ".cache/composer-media/candidate-browser",
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  messages = [],
  projects = [],
  discussions = [],
  invites = [];
const members = [
  { userId: 1, username: "owner", displayName: "林悦", role: "owner" },
];
let executions = 0;
let sharedWidth;
const uploads = new Map();
const picture = await readFile(
  "C:/Users/ADMINI~1/AppData/Local/Temp/2/codex-clipboard-916febdf-f74f-4e3b-acb5-17ace6e34a98.png",
);
async function uploadFixture(route) {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname;
  let data;
  if (path.endsWith("/uploads")) {
    if (req.method() === "GET") data = [];
    else {
      const input = req.postDataJSON();
      const id = "fixture-" + uploads.size;
      data = { ...input, id, offset: 0 };
      uploads.set(id, data);
    }
  } else if (path.includes("/uploads/")) {
    const id = path.split("/uploads/")[1].split("/")[0],
      row = uploads.get(id);
    if (path.endsWith("/complete"))
      data = {
        path: row.path,
        name: row.name,
        fileId: row.id,
        kind: "file",
        size: row.size,
      };
    else {
      row.offset = row.size;
      data = row;
    }
  } else if (path.endsWith("/locate"))
    data = {
      path: url.searchParams.get("path"),
      fileId: "fixture-file",
      kind: "file",
    };
  else if (path.endsWith("/content"))
    return route.fulfill({ contentType: "image/png", body: picture });
  else throw new Error("Uncaught fixture " + path);
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}
await page.route(
  /\/api\/runtime\/v1\/workspaces\/[^/]+\/(uploads|locate|content)/,
  uploadFixture,
);
page.on("pageerror", (error) => errors.push(error.message));
for (const name of ["client.js", "tokens.css"])
  await page.route(`**/plugins/@workagent/dsh-client/${name}*`, (route) =>
    route.fulfill({
      path: resolve(
        process.env.WORKAGENT_COLLAB_CLIENT_DIR ||
          ".cache/composer-media/client",
        name,
      ),
      contentType: name.endsWith("css") ? "text/css" : "text/javascript",
    }),
  );
await page.route(/\/api\/portal\/shared-/, async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    path = url.pathname,
    method = request.method();
  if (
    path.includes("/uploads") ||
    (path.endsWith("/content") &&
      url.searchParams.get("path")?.endsWith(".png"))
  )
    return uploadFixture(route);
  const input =
    method === "POST" || method === "PUT" || method === "PATCH"
      ? request.postDataJSON()
      : {};
  let data = {},
    status = 200;
  if (path.endsWith("shared-events"))
    return route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    });
  if (path.endsWith("shared-projects")) {
    if (method === "POST") {
      const project = {
        id: "project-fixture-123456",
        name: input.name,
        hidden: false,
        currentRole: "owner",
      };
      const conversation = {
        id: "discussion-fixture-123456",
        project_id: project.id,
        name: "项目讨论",
        assistant_id: "",
        state: "idle",
      };
      projects.push(project);
      discussions.push(conversation);
      data = { project, conversation };
      status = 201;
    } else data = { projects };
  } else if (path.endsWith("shared-conversations")) {
    if (method === "PATCH") {
      const row = discussions.find((row) => row.id === input.conversation_id);
      Object.assign(row, input);
      data = { conversation: row };
    } else data = { conversations: discussions };
  } else if (path.endsWith("shared-invites")) data = { invites: [] };
  else if (path.endsWith("/members")) data = { members };
  else if (path.endsWith("shared-users"))
    data = { users: [{ id: 2, username: "colleague", display_name: "张明" }] };
  else if (path.endsWith("/invites")) {
    if (method === "POST") {
      if (invites.length) {
        data = { error: "shared_invite_already_pending" };
        status = 409;
      } else {
        invites.push({
          id: "invite-fixture",
          displayName: "张明",
          username: "colleague",
          status: "pending",
          expiresAt: new Date(Date.now() + 72 * 3600000).toISOString(),
        });
        data = { invite: invites[0] };
        status = 201;
      }
    } else data = { invites };
  } else if (path.endsWith("/assistant")) {
    Object.assign(discussions[0], input);
    data = { conversation: discussions[0] };
  } else if (path.endsWith("shared-messages")) {
    if (method === "POST") {
      const message = {
        ...input,
        id: `message-${messages.length}`,
        seq: messages.length + 1,
        author_name: "linziyan",
        kind: "user",
        is_current_user: true,
        created_at: new Date().toISOString(),
      };
      messages.push(message);
      const started = input.mentions.some((item) => item.kind === "assistant");
      executions += Number(started);
      data = {
        message,
        ai_started: started,
        ai_status: started ? "started" : "not_requested",
      };
    } else data = { messages };
  } else if (path.endsWith("/files"))
    data = [
      { path: "项目简报.md", name: "项目简报.md", kind: "file", size: 24 },
    ];
  else if (path.endsWith("/uploads")) data = [];
  else if (path.endsWith("/content"))
    return route.fulfill({
      contentType: "text/plain",
      body: "共享文件预览验证",
    });
  else {
    status = 404;
    data = { error: "unhandled_fixture_route" };
    errors.push(`${method} ${path}`);
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});
try {
  await login(page);
  const theme = async (label) => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings
      .getByRole("button", { name: "通用设置", exact: true })
      .click();
    await settings.getByRole("button", { name: label, exact: true }).click();
    await page.keyboard.press("Escape");
  };
  await theme("云瓷白");
  const expand = page.getByRole("button", { name: "打开侧边栏", exact: true });
  if (await expand.count()) await expand.click();
  const nav = page.getByRole("navigation", { name: "工作区分类" });
  await nav.getByRole("button", { name: "协作", exact: true }).click();
  assert(
    await nav.getByRole("button", { name: "频道", exact: true }).count(),
    "channel tab missing",
  );
  await page
    .getByRole("button", { name: "新建协作项目", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "新建协作项目",
    exact: true,
  });
  await dialog.getByLabel("共享项目名称", { exact: true }).fill("品牌体验升级");
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await page
    .getByLabel("共享消息", { exact: true })
    .fill("先整理用户反馈，今天确认设计方向。");
  await page
    .locator(".workagent-collab-chat")
    .getByRole("button", { name: "发送消息", exact: true })
    .click();
  await page
    .getByText("先整理用户反馈，今天确认设计方向。", { exact: true })
    .waitFor();
  assert.equal(executions, 0);

  assert.equal(
    await page.locator(".workagent-member-avatar").last().textContent(),
    "L",
  );
  const headerCenters = await page
    .locator(".workagent-top-notifications, .workagent-collab-header-icon")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const b = row.getBoundingClientRect();
        return b.y + b.height / 2;
      }),
    );
  assert(
    Math.max(...headerCenters) - Math.min(...headerCenters) < 1,
    "collaboration header button centers",
  );
  const input = page.getByLabel("共享消息", { exact: true });
  await input.fill("看看这张设计稿，再结合文档一起讨论。");
  await input.evaluate(
    (el, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "design.png", { type: "image/png" }),
      );
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [...picture],
  );
  await page.locator(".workagent-composer-attachments img").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".workagent-composer-attachments img")
        ?.naturalWidth > 0,
  );
  await page.locator(".workagent-collab-messages").evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["brief"], "brief.docx"));
    el.dispatchEvent(
      new DragEvent("dragover", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
    el.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page
    .locator(".workagent-composer-attachments")
    .getByRole("link", { name: "预览 brief.docx" })
    .waitFor();
  assert.equal(uploads.size, 2);
  const preview = page.getByRole("link", { name: "预览 design.png" });
  const popupPromise = page.waitForEvent("popup");
  await preview.click();
  const popup = await popupPromise;
  await popup.close();
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
    [320, 700],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(350);
    const composer = page.locator(".workagent-collab-composer");
    const box = await composer.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1, "composer bounds");
    if (width > 760) {
      const area = await page.locator('.workagent-collab-workspace').boundingBox();
      assert(Math.abs(box.width - (Math.min(area.width, 1080) - 80)) < 1, 'shared width follows personal conversation layout');
      sharedWidth=box.width;
    }
    const img = await composer.locator("img").boundingBox();
    assert(img.width >= 80 && img.height >= 80, "thumbnail size");
    const text = await input.boundingBox();
    assert(img.y + img.height <= text.y + 1, "preview above input");
    await page.screenshot({ path: resolve(out, `collaboration-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await theme("石墨黑");
  await page.screenshot({ path: resolve(out, "collaboration-dark.png") });
  await page.getByRole("button", { name: "移除附件 design.png" }).click();
  await page
    .locator(".workagent-collab-composer")
    .getByRole("button", { name: "发送消息", exact: true })
    .click();
  await page.waitForFunction(
    () => !document.querySelector(".workagent-composer-attachments"),
  );
  assert.deepEqual(messages.at(-1).attachments, ["附件/brief.docx"]);
  assert.equal(executions, 0);
  // The regular task composer uses the same file routing and thumbnail styling.
  await page.goto(baseURL + "/?frontend=dsh");
  await page.locator(".workagent-top-actions").waitFor();
  const centers = await page
    .locator(".workagent-top-actions > button")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const b = row.querySelector("svg").getBoundingClientRect();
        return b.y + b.height / 2;
      }),
    );
  assert(
    centers.length === 2 && Math.abs(centers[0] - centers[1]) < 1,
    "bell and folder centers",
  );
  const editor = page.locator(".workagent-composer-input").first();
  await editor.waitFor();
  await editor.evaluate(
    (el, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "solo.png", { type: "image/png" }),
      );
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [...picture],
  );
  await editor.locator("img").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".workagent-composer-input img")?.naturalWidth > 0,
  );
  await page.screenshot({ path: resolve(out, "solo-dark.png") });
  await editor.getByRole("button", { name: "移除引用 solo.png" }).click();
  assert.equal(await editor.locator("img").count(), 0);
  const sessions = await (await page.request.get(baseURL+'/api/runtime/v1/sessions')).json();
  const existing=(Array.isArray(sessions) ? sessions : sessions.sessions)[0];
  assert(existing,'existing personal task required for width comparison');
  await page.goto(baseURL+'/?frontend=dsh&session='+encodeURIComponent(existing.id));
  const closeFiles=page.getByRole('button',{name:'收起文件侧栏',exact:true});
  if(await closeFiles.count()) await closeFiles.click();
  const personal=page.locator('.workagent-conversation-workspace > .workagent-conversation > .workagent-conversation-composer');
  await personal.waitFor();
  const personalWidth=(await personal.boundingBox()).width;
  assert(Math.abs(personalWidth-sharedWidth)<1,`personal ${personalWidth} shared ${sharedWidth}`);
  await page.screenshot({path:resolve(out,'personal-width-reference.png')});
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(out, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        checks: [
          "shared image paste",
          "page mixed-file drop",
          "image preview popup",
          "remove and send attachments",
          "uppercase member avatar",
          "desktop/mobile preview layout",
          "solo paste preview and remove",
          "notification and folder centers",
          "collaboration header centers", "same width as existing personal task",
        ],
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: resolve(out, "failure.png") });
  await writeFile(
    resolve(out, "report.json"),
    JSON.stringify({ status: "failed", failure: error.stack, errors }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
