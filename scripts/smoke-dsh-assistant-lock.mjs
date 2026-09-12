import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { baseURL, login } from "./smoke-dsh-helpers.mjs";

const candidate = process.env.WORKAGENT_SMOKE_CLIENT;
const out = resolve(
  process.env.WORKAGENT_LOCK_EVIDENCE_DIR || ".cache/assistant-lock/browser",
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = { checks: [], errors: [] };
page.on("pageerror", (error) => report.errors.push(error.message));
try {
  if (candidate)
    await page.route("**/plugins/@workagent/dsh-client/client.js*", (route) =>
      route.fulfill({
        path: resolve(candidate),
        contentType: "text/javascript",
      }),
    );
  await login(page);
  let projectId, discussionId;
  if (candidate) {
    projectId = "lock-fixture-project";
    discussionId = "lock-fixture-discussion";
    let locked = false;
    const conversation = () => ({
      id: discussionId,
      project_id: projectId,
      name: "项目讨论",
      assistant_id: "builtin-codex",
      assistant_backend: "codex",
      model_id: "gpt-5",
      thinking_effort: "medium",
      state: "idle",
      assistant_locked: locked,
    });
    await page.route(/\/api\/portal\/shared-/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      assert.equal(
        route.request().method(),
        "GET",
        "candidate collaboration writes must not reach production",
      );
      if (path.endsWith("shared-events"))
        return route.fulfill({
          contentType: "text/event-stream",
          body: ": ready\n\n",
        });
      const data = path.endsWith("shared-projects")
        ? {
            projects: [
              {
                id: projectId,
                name: "助手上下文验证",
                currentRole: "owner",
                hidden: false,
              },
            ],
          }
        : path.endsWith("shared-conversations")
          ? { conversations: [conversation()] }
          : path.endsWith("shared-messages")
            ? { messages: [] }
            : path.endsWith("/members")
              ? { members: [] }
              : { invites: [] };
      await route.fulfill({ json: data });
    });
    await page.route("**/api/runtime/v1/presets", (route) =>
      route.fulfill({
        json: [
          {
            id: "builtin-codex",
            name: "Codex",
            engine: "codex",
            enabled: true,
          },
          {
            id: "other-agent",
            name: "其他助手",
            engine: "kimi",
            enabled: true,
          },
        ],
      }),
    );
    await page.route("**/api/runtime/v1/model-options", (route) =>
      route.fulfill({
        json: [{ engine: "codex", models: [{ id: "gpt-5", name: "GPT" }] }],
      }),
    );
    await page.goto(
      `${baseURL}/?frontend=dsh&workagent=shared&project=${projectId}&discussion=${discussionId}`,
    );
    await page.getByLabel("项目更多操作").click();
    await page.getByRole("button", { name: "助手设置", exact: true }).click();
    assert.equal(
      await page.getByRole("button", { name: "保存", exact: true }).isEnabled(),
      true,
    );
    report.checks.push("settings editable before first run");
    locked = true;
  } else {
    const response = await page.request.get(
      baseURL + "/api/portal/shared-conversations?include_hidden=true",
    );
    assert(response.ok());
    const { conversations } = await response.json();
    const conversation = conversations.find(
      (row) => row.role === "owner" && row.assistant_locked && !row.hidden,
    );
    assert(
      conversation,
      "existing owner discussion with execution history required",
    );
    projectId = conversation.project_id;
    discussionId = conversation.id;
    const expected = process.env.WORKAGENT_SMOKE_EXPECT_CLIENT;
    if (expected)
      assert.equal(
        await (
          await page.request.get(
            baseURL + "/plugins/@workagent/dsh-client/client.js",
          )
        ).text(),
        await readFile(expected, "utf8"),
      );
    report.checks.push(
      "existing execution history exposed as locked by production API",
    );
  }
  await page.goto(
    `${baseURL}/?frontend=dsh&workagent=shared&project=${encodeURIComponent(projectId)}&discussion=${encodeURIComponent(discussionId)}`,
  );
  if (candidate) {
    await page.getByLabel("共享消息").fill("@");
    await page.getByRole("option", { name: /Codex/ }).waitFor();
    assert.equal(
      await page.getByRole("option", { name: /其他助手/ }).count(),
      0,
    );
    await page.getByLabel("共享消息").fill("");
    report.checks.push(
      "locked discussion only offers the bound agent in @ candidates",
    );
  }
  await page.getByLabel("项目更多操作").click();
  await page.getByRole("button", { name: "助手设置", exact: true }).click();
  const dialog = page
    .locator(".workagent-collab-form")
    .filter({ has: page.getByRole("note") });
  await dialog.getByRole("note").waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "保存", exact: true })
      .isDisabled(),
    true,
  );
  const fields = dialog.locator("select");
  assert((await fields.count()) > 0);
  for (const field of await fields.all())
    assert(
      await field.isDisabled(),
      await field.evaluate(
        (el) =>
          el.outerHTML + el.parentElement.parentElement.outerHTML.slice(0, 250),
      ),
    );
  await page.screenshot({ path: out + "/desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  if (
    !(await page.locator(".hHd-Xa_root").getAttribute("class")).includes(
      "hHd-Xa_collapsed",
    )
  )
    await page.locator(".hHd-Xa_toggle").click();
  await page.locator(".hHd-Xa_collapsed").waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: out + "/mobile.png" });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  report.checks.push(
    "assistant settings locked on desktop and mobile; no collaboration writes",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.message;
  await page.screenshot({ path: out + "/failure.png" });
  throw error;
} finally {
  await writeFile(out + "/report.json", JSON.stringify(report, null, 2));
  await browser.close();
}
