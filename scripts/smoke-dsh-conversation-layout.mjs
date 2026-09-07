import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { baseURL, withPage } from "./smoke-dsh-helpers.mjs";
const output =
  process.env.WORKAGENT_SMOKE_EVIDENCE_DIR ||
  ".cache/conversation-layout-evidence";
await mkdir(output, { recursive: true });
await withPage(async (page) => {
  await page.route(
    (url) => url.pathname.startsWith("/api/runtime/v1/sessions/layout-"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const id = path.split("/")[5];
      if (path.endsWith("/events"))
        return route.fulfill({ contentType: "text/event-stream", body: "" });
      return route.fulfill({
        json: path.endsWith("/messages")
          ? [
              { id: "user-1", role: "user", text: "请帮我整理需求。" },
              {
                id: "assistant-1",
                role: "assistant",
                text: "已经整理好，可以继续补充需求。",
              },
            ]
          : {
              id,
              engine: "kimi",
              title:
                id === "layout-side" ? "关于实现细节的侧聊" : "会话控制验收",
              activity: { state: "idle" },
            },
      });
    },
  );
  for (const [width, files] of [
    [1280, true],
    [1280, false],
    [390, false],
  ]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate((files) => {
      localStorage.setItem("workagent.side-chat.layout-main", "layout-side");
      localStorage.setItem("workagent.files.open", String(files));
    }, files);
    await page.goto(`${baseURL}/?frontend=dsh&session=layout-main`);
    await page.getByLabel("侧聊消息", { exact: true }).waitFor();
    await page.getByText("会话控制验收", { exact: true }).waitFor();
    const chats = page.locator(".workagent-conversation");
    for (let i = 0; i < 2; i++) {
      const chat = chats.nth(i);
      const box = await chat.boundingBox();
      const header = await chat
        .locator(".workagent-conversation-title")
        .boundingBox();
      const list = await chat.locator(".workagent-message-list").boundingBox();
      const composer = await chat
        .locator(".workagent-conversation-composer")
        .boundingBox();
      assert.ok(box.width >= 280);
      assert.ok(
        list.y >= header.y + header.height - 1,
        "Header overlaps history",
      );
      assert.ok(
        composer.y >= list.y + list.height - 1,
        "History overlaps composer",
      );
      assert.ok(composer.height >= 110, "Composer is collapsed");
      assert.ok(
        composer.y + composer.height <= box.y + box.height + 1,
        "Composer overflows chat",
      );
    }
    const first = await chats.nth(0).boundingBox();
    const second = await chats.nth(1).boundingBox();
    assert.ok(
      second.x >= first.x + first.width || second.y >= first.y + first.height,
      "Chats overlap",
    );
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `${output}/layout-${width}-${files}.png`,
      fullPage: true,
    });
    if (files || width < 700) {
      await page
        .getByLabel("侧聊消息", { exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${output}/layout-${width}-${files}-side.png`,
        fullPage: true,
      });
    }
  }
});
console.log(
  "Conversation layout: both composers remain usable at desktop, files-open and mobile widths",
);
