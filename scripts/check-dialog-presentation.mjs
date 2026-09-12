import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bundleStyles } from "../packages/dsh-client-workagent/build.mjs";

// Exercise browser layout, native modal behavior, and real source styles offline.
// Unlike the DOM unit tests, this detects ancestor stacking and inertness bugs.
const clientRoot = new URL(
  "../packages/dsh-client-workagent/",
  import.meta.url,
);
const { build } = createRequire(new URL("package.json", clientRoot))("esbuild");
const fixture = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { Dialog, useConfirm } from "./src/ui/dialog.js";
  import { Button, Input } from "./src/ui/elements.js";
  const h = React.createElement;
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [actions, setActions] = React.useState(0);
    const [confirmed, setConfirmed] = React.useState(0);
    const [sidebarClicks, setSidebarClicks] = React.useState(0);
    const { confirm, confirmation } = useConfirm();
    window.setDialogBusy = setBusy;
    return h(React.Fragment, null,
      h("div", { className: "workagent-overlay" },
        h("main", { className: "workagent-overlay-content" },
          h("div", { className: "workagent-conversation-workspace" },
            h(Button, { id: "open-dialog", onClick: () => setOpen(true) }, "项目成员"),
            h("output", { id: "actions" }, actions),
            h("output", { id: "confirmed" }, confirmed),
            open && h(Dialog, { title: "项目成员", closeDisabled: busy, onClose: () => setOpen(false) },
              h(Input, { id: "hidden-input", style: { display: "none" } }),
              h(Input, { id: "untabbable-input", tabIndex: -1 }),
              h(Input, { id: "member-search", "aria-label": "搜索成员" }),
              h("div", { className: "workagent-dialog-actions" },
                h(Button, { id: "open-confirm", onClick: async () => {
                  if (await confirm({ title: "移除成员", description: "确认移除此成员？", danger: true, confirmLabel: "移除" })) {
                    setConfirmed(value => value + 1);
                  }
                } }, "移除成员"),
                h(Button, { id: "layer-action", variant: "primary", onClick: () => setActions(value => value + 1) }, "保存成员")),
              h("details", { id: "member-details" },
                h("summary", { id: "member-menu" }, "管理成员"),
                h(Button, { id: "member-remove" }, "移除成员"),
                h(Button, { id: "member-transfer" }, "转移所有权")),
              h("div", { style: { visibility: "hidden" } }, h(Button, null, "隐藏操作")),
              h(Button, { disabled: true }, "不可用操作"),
              confirmation)))),
      h("aside", { id: "file-panel", className: "workagent-files-panel", style: {
        position: "fixed", top: 0, right: 0, bottom: 0, width: 440, height: "100%", zIndex: 32
      } },
        h(Button, { id: "sidebar-action", style: { height: "100%" }, onClick: () => setSidebarClicks(value => value + 1) }, "侧栏文件"),
        h("output", { id: "sidebar-clicks" }, sidebarClicks)));
  }
  createRoot(document.getElementById("root")).render(h(Fixture));
`;

const [bundle, styles] = await Promise.all([
  build({
    stdin: {
      contents: fixture,
      resolveDir: fileURLToPath(clientRoot),
      loader: "js",
    },
    bundle: true,
    format: "iife",
    write: false,
  }),
  bundleStyles(),
]);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  await page.addStyleTag({ content: styles.code });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const expectFocus = async (selector) => {
    try {
      await page.waitForFunction(
        (value) => document.activeElement === document.querySelector(value),
        selector,
      );
    } catch (error) {
      const active = await page.evaluate(() => ({
        tag: document.activeElement.tagName,
        id: document.activeElement.id,
      }));
      throw new Error(
        `Expected focus on ${selector}; actual ${JSON.stringify(active)}`,
        {
          cause: error,
        },
      );
    }
  };
  const expectModalCount = (count) =>
    page.waitForFunction(
      (value) => document.querySelectorAll("dialog:modal").length === value,
      count,
    );
  const openDialog = async () => {
    await page.locator("#open-dialog").click();
    await expectModalCount(1);
    await expectFocus("#member-search");
  };
  const expectClosed = async () => {
    await expectModalCount(0);
    await expectFocus("#open-dialog");
    assert.equal(await page.locator("#sidebar-clicks").textContent(), "0");
  };

  await openDialog();
  const layer = await page.evaluate(() => {
    const surface = document.querySelector("[data-workagent-dialog]");
    const host = surface.parentElement.getBoundingClientRect();
    const rect = surface.getBoundingClientRect();
    const sidebar = document
      .getElementById("file-panel")
      .getBoundingClientRect();
    return {
      host: { x: host.x, y: host.y, width: host.width, height: host.height },
      overlapsSidebar: rect.right > sidebar.left,
      covered: !surface.contains(
        document.elementFromPoint(rect.right - 8, rect.top + 50),
      ),
    };
  });
  assert.deepEqual(layer.host, { x: 0, y: 0, width: 1100, height: 800 });
  assert.equal(
    layer.overlapsSidebar,
    true,
    "fixture must reproduce the sidebar overlap",
  );
  assert.equal(
    layer.covered,
    false,
    "modal must escape the page's stacking context",
  );
  const action = await page.locator("#layer-action").boundingBox();
  assert.ok(
    action.x + action.width - 4 > 660,
    "test the part over the sidebar",
  );
  await page.mouse.click(
    action.x + action.width - 4,
    action.y + action.height / 2,
  );
  assert.equal(await page.locator("#actions").textContent(), "1");

  await page.locator("#member-menu").focus();
  await page.keyboard.press("Tab");
  await expectFocus(".workagent-dialog-close");
  await page.keyboard.press("Shift+Tab");
  await expectFocus("#member-menu");
  await page.keyboard.press("Enter");
  await page.locator("#member-transfer").focus();
  await page.keyboard.press("Tab");
  await expectFocus(".workagent-dialog-close");
  await page.locator("#member-menu").click();

  const openConfirmation = async () => {
    await page.locator("#open-confirm").click();
    await expectModalCount(2);
    await expectFocus('[role="alertdialog"] [data-dialog-autofocus]');
  };
  const expectOuterRestored = async () => {
    await expectModalCount(1);
    await expectFocus("#open-confirm");
  };
  await openConfirmation();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expectOuterRestored();
  assert.equal(await page.locator("#confirmed").textContent(), "0");
  await openConfirmation();
  await page.keyboard.press("Escape");
  await expectOuterRestored();
  await openConfirmation();
  await page.mouse.click(1050, 700);
  await expectOuterRestored();
  assert.equal(await page.locator("#confirmed").textContent(), "0");
  await openConfirmation();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "移除", exact: true })
    .click();
  await expectOuterRestored();
  assert.equal(await page.locator("#confirmed").textContent(), "1");

  await page
    .getByRole("dialog", { name: "项目成员", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expectClosed();
  await openDialog();
  await page.keyboard.press("Escape");
  await expectClosed();
  await openDialog();
  await page.mouse.click(1050, 700);
  await expectClosed();

  await openDialog();
  await page.evaluate(() => window.setDialogBusy(true));
  await page.waitForFunction(
    () => document.querySelector(".workagent-dialog-close").disabled,
  );
  await page.keyboard.press("Escape");
  await page.mouse.click(1050, 700);
  assert.equal(await page.locator("dialog:modal").count(), 1);
  await page.evaluate(() => window.setDialogBusy(false));
  await page.waitForFunction(
    () => !document.querySelector(".workagent-dialog-close").disabled,
  );
  await page.keyboard.press("Escape");
  await expectClosed();
  assert.deepEqual(errors, [], "fixture must not produce browser errors");
  console.log(
    "Dialog presentation checks passed: stacking, keyboard focus, nested confirmation, dismissal, and focus restoration.",
  );
} finally {
  await browser.close();
}
