import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  login,
  baseURL,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";

requireSmokeEnvironment();
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(evidence, { recursive: true });
const candidate = process.env.WORKAGENT_SMOKE_CLIENT
  ? await readFile(process.env.WORKAGENT_SMOKE_CLIENT, "utf8")
  : undefined;
const expected = await readFile(
  process.env.WORKAGENT_SMOKE_EXPECT_CLIENT,
  "utf8",
);
const browser = await chromium.launch();
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  if (candidate)
    await page.route("**/plugins/@workagent/dsh-client/client.js*", (route) =>
      route.fulfill({ contentType: "text/javascript", body: candidate }),
    );
  await login(page);
  await page.locator(".workagent-sidebar-projects").first().waitFor();
  if (!candidate) {
    const response = await page.request.get(
      `${baseURL}/plugins/@workagent/dsh-client/client.js`,
    );
    assert.equal(await response.text(), expected);
  }
  checks.push("authenticated home and candidate payload");
  await page.screenshot({ path: `${evidence}/home.png`, fullPage: true });

  // Browser-only fixtures: no project or conversation is written to production.
  const projects = [
    {
      id: "order-old",
      name: "排序验证·旧项目新聊天",
      createdAt: "2026-09-01T00:00:00Z",
      scope: "personal",
    },
    {
      id: "order-new",
      name: "排序验证·最近创建",
      createdAt: "2026-09-10T00:00:00Z",
      scope: "personal",
    },
    {
      id: "order-middle",
      name: "排序验证·较早聊天",
      createdAt: "2026-09-09T00:00:00Z",
      scope: "personal",
    },
  ];
  let chats = [
    {
      id: "order-chat-1",
      title: "最近聊天",
      workspaceId: "order-old",
      updatedAt: "2026-09-11T00:00:00Z",
    },
    {
      id: "order-chat-2",
      title: "较早聊天",
      workspaceId: "order-middle",
      updatedAt: "2026-09-09T12:00:00Z",
    },
  ];
  await page.route("**/workspaces", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: projects })
      : route.continue(),
  );
  await page.route("**/sessions", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: chats })
      : route.continue(),
  );
  await page.reload();
  const rows = page.locator(".workagent-sidebar-project-row > button.is-main");
  await rows.filter({ hasText: projects[0].name }).waitFor();
  assert.deepEqual(await rows.allTextContents(), [
    projects[0].name,
    projects[1].name,
    projects[2].name,
  ]);
  checks.push("latest chat descending with project creation fallback");
  chats = [
    ...chats,
    {
      id: "order-chat-3",
      title: "更新聊天",
      workspaceId: "order-middle",
      updatedAt: "2026-09-12T00:00:00Z",
    },
  ];
  await page.evaluate(() =>
    window.dispatchEvent(new Event("workagent:sessions-changed")),
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".workagent-sidebar-project-row > button.is-main")
        ?.textContent === "排序验证·较早聊天",
  );
  assert.deepEqual(await rows.allTextContents(), [
    projects[2].name,
    projects[0].name,
    projects[1].name,
  ]);
  checks.push("live chat refresh reorders projects");
  await page.screenshot({ path: `${evidence}/sorted.png`, fullPage: true });
  await page.route("**/shared-projects?*", (route) =>
    route.fulfill({ json: { projects } }),
  );
  await page.route("**/shared-conversations?*", (route) =>
    route.fulfill({
      json: {
        conversations: chats.map((chat) => ({
          id: chat.id,
          project_id: chat.workspaceId,
          name: chat.title,
          updated_at: chat.updatedAt,
          state: "idle",
          hidden: false,
        })),
      },
    }),
  );
  await page.reload();
  await page
    .locator(".workagent-sidebar-tabs button")
    .filter({ hasText: /^协作/ })
    .click();
  await rows.filter({ hasText: projects[0].name }).waitFor();
  assert.deepEqual(await rows.allTextContents(), [
    projects[2].name,
    projects[0].name,
    projects[1].name,
  ]);
  checks.push(
    "shared projects use the same chat recency and creation fallback",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    `${evidence}/report.json`,
    JSON.stringify({ status: "passed", checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ status: "passed", checks }));
} finally {
  await browser.close();
}
