import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";

const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(output, { recursive: true });
await withPage(async (page) => {
  if (process.env.WORKAGENT_SMOKE_LOCAL_ASSETS === "1") {
    for (const [file, contentType] of [
      ["client.js", "application/javascript"],
      ["tokens.css", "text/css"],
    ]) {
      await page.route(
        (url) =>
          url.pathname.includes("@workagent/dsh-client/") &&
          url.pathname.endsWith(file),
        (route) =>
          route.fulfill({
            path: `packages/dsh-client-workagent/${file}`,
            contentType,
          }),
      );
    }
  }
  const created = [];
  const reports = [];
  const post = async (path, body = {}) =>
    json(page, path, { method: "POST", body: JSON.stringify(body) });
  try {
    const main = await post("/api/runtime/v1/sessions", {
      engine: "codex",
      presetId: "builtin-codex",
      title: "整理下一阶段的工作计划",
      workspace: "default",
      permissionMode: "read_only",
    });
    created.push(main.id);
    const side = await post(`/api/runtime/v1/sessions/${main.id}/side-chat`);
    created.push(side.id);
    const second = await post(`/api/runtime/v1/sessions/${main.id}/side-chat`);
    created.push(second.id);
    let populated = false;
    let longHistory = false;
    await page.route(
      `**/api/runtime/v1/sessions/${side.id}/messages`,
      (route) =>
        route.fulfill({
          json: populated
            ? [
                {
                  id: "visual-user",
                  role: "user",
                  text: "顺便问一下，优先级应该怎么排？",
                },
                {
                  id: "visual-assistant",
                  role: "assistant",
                  text: "可以先按这三个维度判断：\n\n1. **影响范围**：优先解决影响日常使用的问题。\n2. **紧急程度**：明确哪些事项有截止时间。\n3. **投入成本**：先安排能快速完成的小改进。\n\n把最重要的两件事放到今天，其余留到后续迭代。",
                },
              ].flatMap((message) =>
                longHistory
                  ? Array.from({ length: 12 }, (_, i) => ({
                      ...message,
                      id: `${message.id}-${i}`,
                    }))
                  : [message],
              )
            : [],
        }),
    );
    for (const [name, width, theme, filled, files] of [
      ["empty-light", 1440, "light", false, false],
      ["messages-light", 1440, "light", true, false],
      ["messages-dark", 1440, "dark", true, false],
      ["messages-warm", 1440, "warm", true, false],
      ["long-history", 1440, "light", true, false],
      ["files-open", 1280, "light", true, true],
      ["mobile", 390, "light", true, false],
    ]) {
      populated = filled;
      longHistory = name === "long-history";
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        ({ main, side, files, theme }) => {
          localStorage.setItem(`workagent.side-chat.${main}`, side);
          localStorage.setItem("workagent.files.open", String(files));
          localStorage.setItem(
            "workagent.appearance.v1",
            JSON.stringify({
              mode: { light: "porcelain", dark: "graphite", warm: "paper" }[
                theme
              ],
              daylight: "porcelain",
            }),
          );
        },
        { main: main.id, side: side.id, files, theme },
      );
      await page.goto(`${baseURL}/?frontend=dsh&session=${main.id}`);
      const panel = page.getByRole("complementary", { name: "侧聊 BTW" });
      await panel.getByLabel("侧聊消息", { exact: true }).waitFor();
      await page
        .locator(
          ".workagent-conversation-workspace > .workagent-conversation .workagent-conversation-title strong",
        )
        .getByText("整理下一阶段的工作计划", { exact: true })
        .waitFor();
      await panel.getByRole("combobox", { name: "选择侧聊" }).waitFor();
      if (filled)
        await panel
          .locator(
            ".workagent-message.is-assistant .workagent-engine-mark.is-codex",
          )
          .first()
          .waitFor();
      if (filled)
        await panel
          .getByText("顺便问一下，优先级应该怎么排？", { exact: true })
          .first()
          .waitFor();
      else await panel.getByText("顺便问一句", { exact: true }).waitFor();
      await panel.scrollIntoViewIfNeeded();
      const resize = page.getByRole("separator", { name: "调整侧聊宽度" });
      if (name === "empty-light") {
        await resize.waitFor();
        const panelWidth = async () => (await panel.boundingBox()).width;
        const dragBy = async (delta) => {
          const box = await resize.boundingBox();
          const x = box.x + box.width / 2;
          const y = box.y + 100;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + delta, y, { steps: 12 });
          await page.mouse.up();
          assert.equal(
            await page.locator("body.workagent-resizing").count(),
            0,
            "Releasing the divider must finish resizing",
          );
        };
        const initial = await panelWidth();
        await dragBy(-140);
        assert.ok(Math.abs((await panelWidth()) - initial - 140) <= 2);
        await dragBy(90);
        assert.ok(Math.abs((await panelWidth()) - initial - 50) <= 2);
        const beforeKey = await panelWidth();
        await resize.focus();
        await page.keyboard.press("ArrowLeft");
        assert.ok(Math.abs((await panelWidth()) - beforeKey - 24) <= 1);
        await page.keyboard.press("ArrowRight");
        assert.ok(Math.abs((await panelWidth()) - beforeKey) <= 1);
        await dragBy(-2000);
        const mainWidth = await page
          .locator(
            ".workagent-conversation-workspace > .workagent-conversation",
          )
          .evaluate((el) => el.getBoundingClientRect().width);
        assert.ok(
          mainWidth >= 359,
          "Resizing must preserve a usable main chat",
        );
        await dragBy(2000);
        assert.ok(Math.abs((await panelWidth()) - 320) <= 1);
        await dragBy(-160);
        const savedWidth = await panelWidth();
        await page.reload();
        await resize.waitFor();
        assert.ok(Math.abs((await panelWidth()) - savedWidth) <= 1);
        await page.setViewportSize({ width: 390, height: 900 });
        assert.equal(await resize.isVisible(), false);
        await page.setViewportSize({ width: 1440, height: 900 });
        await resize.waitFor();
        assert.ok(Math.abs((await panelWidth()) - savedWidth) <= 1);
        await page.screenshot({
          path: join(output, "side-resized.png"),
          animations: "disabled",
        });
        reports.push({
          name: "resize",
          initial,
          savedWidth,
          dragBothDirections: true,
          keyboard: true,
          bounds: true,
          survivesReloadAndViewportChanges: true,
        });
      }
      if (name === "mobile") assert.equal(await resize.isVisible(), false);
      if (name === "files-open") {
        assert.equal(
          await resize.isVisible(),
          false,
          "A narrow conversation container must hide the side resize handle",
        );
        assert.equal(
          await page
            .locator(".workagent-conversation-workspace")
            .evaluate((el) => getComputedStyle(el).flexDirection),
          "column",
          "A narrow conversation container must stack the side chat",
        );
      }
      if (longHistory) {
        const scrolled = await panel
          .locator(".workagent-message-list")
          .evaluate((el) => {
            el.scrollTop = el.scrollHeight;
            return el.scrollTop > 0 && el.scrollHeight > el.clientHeight;
          });
        assert.ok(scrolled, "Long side history must scroll within the panel");
      }
      const bounds = await panel.evaluate((el) => {
        const rect = (selector) => {
          const r = el.querySelector(selector).getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            bottom: r.bottom,
            right: r.right,
          };
        };
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          header: rect(".workagent-side-header"),
          list: rect(".workagent-message-list"),
          composer: rect(".workagent-conversation-composer"),
          create: rect('[aria-label="新侧聊"]'),
          remove: rect('[aria-label="删除侧聊"]'),
          horizontalOverflow: el.scrollWidth > el.clientWidth + 1,
        };
      });
      assert.ok(!bounds.horizontalOverflow);
      assert.ok(bounds.right <= width + 1 && bounds.x >= 0);
      assert.ok(Math.abs(bounds.create.y - bounds.remove.y) < 1);
      assert.ok(bounds.list.y >= bounds.header.bottom - 1);
      assert.ok(bounds.composer.y >= bounds.list.bottom - 1);
      assert.ok(bounds.composer.bottom <= bounds.bottom - 1);
      await page.screenshot({
        path: join(output, `side-${name}.png`),
        animations: "disabled",
      });
      reports.push({ name, ...bounds });
    }
    const panel = page.getByRole("complementary", { name: "侧聊 BTW" });
    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/sessions/${main.id}/side-chat`),
    );
    await panel.getByRole("button", { name: "新侧聊", exact: true }).click();
    const fresh = await (await createdResponse).json();
    created.push(fresh.id);
    await panel.getByText("顺便问一句", { exact: true }).waitFor();
    assert.equal(await panel.getByLabel("选择侧聊").inputValue(), fresh.id);
    await panel.getByLabel("选择侧聊").selectOption(side.id);
    await panel
      .getByText("顺便问一下，优先级应该怎么排？", { exact: true })
      .waitFor();
    await panel.getByRole("button", { name: "删除侧聊", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", {
      name: "确认删除侧聊",
    });
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.equal(await panel.getByLabel("选择侧聊").inputValue(), side.id);
    await writeFile(
      join(output, "side-polish.json"),
      JSON.stringify(reports, null, 2),
    );
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const id of created.reverse())
      await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
  }
});
console.log(
  "Side chat header, empty state, messages and composer layouts verified",
);
