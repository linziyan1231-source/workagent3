import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { baseURL, withPage } from "./smoke-dsh-helpers.mjs";

const output =
  process.env.WORKAGENT_SMOKE_EVIDENCE_DIR || ".cache/chat-polish-evidence";
await mkdir(output, { recursive: true });
await withPage(async (page) => {
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: baseURL,
    });
  if (process.env.WORKAGENT_SMOKE_LOCAL_CLIENT) {
    for (const file of ["client.js", "tokens.css"])
      await page.route(
        `**/plugins/@workagent/dsh-client/${file}*`,
        async (route) =>
          route.fulfill({
            contentType: file.endsWith("css") ? "text/css" : "text/javascript",
            body: await readFile(
              `packages/dsh-client-workagent/${file}`,
              "utf8",
            ),
          }),
      );
  }
  await page.route(
    (url) => url.pathname.startsWith("/api/runtime/v1/sessions/polish-"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const id = path.split("/")[5];
      if (path.endsWith("/events"))
        return route.fulfill({ contentType: "text/event-stream", body: "" });
      await route.fulfill({
        json: path.endsWith("/messages")
          ? [
              ...Array.from({ length: 8 }, (_, i) => ({
                id: `earlier-${i}`,
                role: "assistant",
                text: "之前的讨论。\n\n这段内容用于检查滚动后顶部图标的位置。",
              })),
              {
                id: "user-1",
                role: "user",
                text: "创建一个 docx 文件，里面随便写点东西",
              },
              {
                id: "assistant-1",
                role: "assistant",
                text: "已创建 **随便写写.docx**，里面包含四段内容：\n\n- 这是一个随便写点内容的 Word 文档。\n- 今天天气不错，适合写代码。\n- Lorem ipsum dolor sit amet...\n- 一二三四五，上山打老虎。\n\n1. 文件位于当前工作目录。\n2. 可以继续修改文件名或内容。",
              },
            ]
          : {
              id,
              engine: "kimi",
              title: id === "polish-side" ? "侧聊" : "聊天界面验收",
              activity: { state: "idle" },
            },
      });
    },
  );
  for (const [width, side, files] of [
    [1600, false, false],
    [1600, true, false],
    [1280, true, true],
    [390, true, false],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      ({ side, files }) => {
        localStorage.setItem("workagent.files.open", String(files));
        if (side)
          localStorage.setItem(
            "workagent.side-chat.polish-main",
            "polish-side",
          );
        else localStorage.removeItem("workagent.side-chat.polish-main");
      },
      { side, files },
    );
    await page.goto(`${baseURL}/?frontend=dsh&session=polish-main`);
    await page.getByLabel("继续对话", { exact: true }).waitFor();
    const toolbar = page.locator(".workagent-top-actions");
    await toolbar.waitFor();
    const bell = toolbar.locator(".workagent-top-notifications");
    const folder = toolbar.locator(".workagent-files-toggle");
    const positions = async () => ({
      bell: await bell.boundingBox(),
      folder: await folder.boundingBox(),
    });
    const before = await positions();
    assert.equal(
      before.bell.y,
      before.folder.y,
      "Header icons must align vertically",
    );
    assert.equal(before.bell.height, before.folder.height);
    assert.equal(
      (await page.locator(".workagent-overlay-header").boundingBox()).height,
      48,
    );
    assert.equal(
      await page.getByText("内容将保存到当前会话", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByText("侧聊不会写入主会话", { exact: true }).count(),
      0,
    );
    const main = page.locator(".workagent-conversation").first();
    await main.locator('[data-message-id="user-1"]').scrollIntoViewIfNeeded();
    const actions = main.locator(
      '[data-message-id="user-1"] .workagent-message-actions',
    );
    await page.mouse.move(1, 450);
    await page.waitForTimeout(160);
    assert.equal(
      await actions.evaluate((el) => getComputedStyle(el).opacity),
      "0",
    );
    const user = main.locator('[data-message-id="user-1"]');
    await user.hover();
    await page.waitForTimeout(160);
    assert.equal(
      await actions.evaluate((el) => getComputedStyle(el).opacity),
      "1",
    );
    const edit = actions.getByRole("button", { name: "编辑", exact: true });
    assert.equal(
      await user.getByRole("button", { name: "分支", exact: true }).count(),
      0,
    );
    const reply = main.locator('[data-message-id="assistant-1"]');
    assert.equal(
      await reply.getByRole("button", { name: "分支", exact: true }).count(),
      1,
    );
    assert.equal(
      await reply.getByRole("button", { name: "编辑", exact: true }).count(),
      0,
    );
    assert.equal(
      await user.getByRole("button", { name: "复制", exact: true }).count(),
      1,
    );
    assert.equal(
      await reply.getByRole("button", { name: "复制", exact: true }).count(),
      1,
    );
    assert.equal(await page.getByText("分支 Fork", { exact: true }).count(), 0);
    assert.equal(
      await page.getByText("返回原会话", { exact: true }).count(),
      0,
    );
    assert.equal(await page.getByText("侧聊 BTW", { exact: true }).count(), 0);
    for (const [row, expected] of [
      [user, "创建一个 docx 文件，里面随便写点东西"],
      [reply, "已创建 **随便写写.docx**"],
    ]) {
      await row.hover();
      await row.getByRole("button", { name: "复制", exact: true }).click();
      await row.getByRole("button", { name: "已复制", exact: true }).waitFor();
      assert.ok(
        (await page.evaluate(() => navigator.clipboard.readText())).startsWith(
          expected,
        ),
      );
    }
    await user.hover();
    await edit.hover();
    assert.equal(
      await edit.evaluate((el) => getComputedStyle(el, "::after").content),
      '"编辑"',
    );
    assert.equal(await edit.textContent(), "");
    assert.equal(await edit.locator("svg").count(), 1);
    await edit.click();
    await main.getByLabel("编辑消息", { exact: true }).waitFor();
    await main.getByRole("button", { name: "取消编辑" }).click();
    await page.mouse.move(1, 450);
    await edit.focus();
    await page.waitForTimeout(160);
    assert.equal(
      await actions.evaluate((el) => getComputedStyle(el).opacity),
      "1",
      "Keyboard focus reveals controls",
    );
    await edit.blur();
    for (const chat of await page.locator(".workagent-conversation").all()) {
      const markdown = chat.locator(
        '[data-message-id="assistant-1"] .workagent-markdown',
      );
      await markdown.waitFor();
      assert.equal(await markdown.locator("ul > li").count(), 4);
      assert.equal(await markdown.locator("ol > li").count(), 2);
      assert.ok(
        await markdown.evaluate((el) =>
          [...el.querySelectorAll("li")].every(
            (li) =>
              li.getBoundingClientRect().left -
                el.getBoundingClientRect().left >
              20,
          ),
        ),
        "List markers need space inside the bubble",
      );
      await chat
        .locator(".workagent-message-list")
        .evaluate((el) => (el.scrollTop = 0));
      await chat.locator(".workagent-message-list").hover();
      await page.mouse.wheel(0, -700);
    }
    await page
      .locator(".workagent-overlay")
      .evaluate((el) => (el.scrollTop = 600));
    assert.deepEqual(
      await positions(),
      before,
      "Both header controls must stay fixed during scrolling",
    );
    await main
      .locator('[data-message-id="assistant-1"]')
      .scrollIntoViewIfNeeded();
    await user.hover();
    await page.waitForTimeout(160);
    await page.screenshot({
      path: `${output}/chat-${width}-${side}-${files}.png`,
      fullPage: true,
    });
  }
});
console.log(
  "Chat polish: contained lists, hover/focus icons, compact header and synchronized scroll positions passed",
);
