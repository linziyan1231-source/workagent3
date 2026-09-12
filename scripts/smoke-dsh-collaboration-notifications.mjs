import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { login, baseURL } from "./smoke-dsh-helpers.mjs";

// Candidate visual/interaction checks use isolated in-memory API fixtures.
// Production supplies only the authenticated shell; all collaboration writes
// are intercepted. Backend transaction/ACL tests run independently in Go.
const out = resolve(
  process.env.WORKAGENT_COLLAB_EVIDENCE_DIR || ".cache/collaboration/browser",
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
page.on("pageerror", (error) => errors.push(error.message));
let reminderState={enabled:false,targetId:"",targets:[{id:"fixture-im",label:"测试聊天",connected:true}],sessionSettings:{}};
await page.route(/\/api\/runtime\/v1\/completion-notifications(?:\/|$|\?)/,async route=>{
  if(route.request().method()==='PUT') {
    const input=route.request().postDataJSON();
    assert.equal(input.sessionId,'collaboration:discussion-fixture-123456');
    reminderState.sessionSettings[input.sessionId]=input;
  }
  await route.fulfill({json:reminderState});
});
for (const name of ["client.js", "tokens.css"])
  await page.route(`**/plugins/@workagent/dsh-client/${name}*`, (route) =>
    route.fulfill({
      path: resolve(
        process.env.WORKAGENT_COLLAB_CLIENT_DIR ||
          "packages/dsh-client-workagent",
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
  } else if (path.endsWith("/assistants"))
    data = { assistants: discussions[0]?.assistants || [] };
  else if (path.endsWith("/assistant-options")) data = { assistants: [] };
  else if (path.endsWith("shared-messages")) {
    if (method === "POST") {
      const message = {
        ...input,
        id: `message-${messages.length}`,
        seq: messages.length + 1,
        author_name: "林悦",
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
  else if (path.endsWith("/move") && method === "GET") data = [];
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
  assert.equal(
    await page.getByRole("checkbox", { name: "协作模式", exact: true }).count(),
    0,
    "personal home must not expose the obsolete collaboration toggle",
  );
  await page.getByText("Enter 发送", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/personal-home.png` });
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
  await page.getByLabel('消息提醒',{exact:true}).click();
  await page.getByLabel('当前会话接收聊天').selectOption('fixture-im');
  await page.getByRole('button',{name:'开启消息提醒',exact:true}).click();
  await page.getByRole('button',{name:'关闭提醒',exact:true}).waitFor();
  assert.equal(reminderState.sessionSettings['collaboration:discussion-fixture-123456'].enabled,true);
  await page.screenshot({path:`${out}/desktop-reminder.png`});
  await page.getByLabel('消息提醒',{exact:true}).click();
  const layouts=[];
  for(const width of [1440,768,430,375,320]) {
    await page.setViewportSize({width,height:900});
    await page.getByRole('button',{name:'文件',exact:true}).click();
    const box=await page.getByLabel('项目文件侧栏',{exact:true}).boundingBox();
    assert(box && Math.abs(box.x+box.width-width)<2 && box.x>=0,`files must dock right at ${width}`);
    await page.screenshot({path:`${out}/files-right-${width}.png`});
    await page.getByRole('button',{name:'关闭文件侧栏',exact:true}).click();
    await page.getByLabel('消息提醒',{exact:true}).click();
    const popup=await page.locator('.workagent-collab-reminder-popover').boundingBox();
    assert(popup && popup.x>=0 && popup.x+popup.width<=width,`reminder popup clipped at ${width}`);
    await page.screenshot({path:`${out}/reminder-${width}.png`});
    await page.getByLabel('消息提醒',{exact:true}).click();
    layouts.push({width,files:box,reminder:popup});
  }
  assert.deepEqual(errors,[]);
  await writeFile(`${out}/notification-report.json`,JSON.stringify({passed:true,mode:'isolated fixtures',layouts,errors},null,2));
} catch(error) {
  await page.screenshot({path:`${out}/notification-failure.png`});
  throw error;
} finally {await browser.close();}
