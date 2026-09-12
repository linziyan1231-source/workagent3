import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  baseURL,
  login,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";

requireSmokeEnvironment();
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("Evidence directory required");
await mkdir(evidence, { recursive: true });
const candidate = process.env.WORKAGENT_SMOKE_IM_CLIENT
  ? await readFile(process.env.WORKAGENT_SMOKE_IM_CLIENT, "utf8")
  : undefined;
const client = process.env.WORKAGENT_SMOKE_CLIENT
  ? await readFile(process.env.WORKAGENT_SMOKE_CLIENT, "utf8")
  : undefined;
const expectedClient = process.env.WORKAGENT_SMOKE_EXPECT_IM_CLIENT
  ? await readFile(process.env.WORKAGENT_SMOKE_EXPECT_IM_CLIENT)
  : undefined;
const report = { status: "running", checks: [], snapshots: [], errors: [] };
const browser = await chromium.launch();
try {
  for (const delayed of ["workagent", "channels"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "warning" &&
        message.text().includes("包裹官方任务树失败")
      )
        report.errors.push(message.text());
    });
    let delayedPlugin = delayed;
    await page.route(
      "**/plugins/@workagent/dsh-client/client.js*",
      async (route) => {
        if (delayedPlugin === "workagent")
          await new Promise((done) => setTimeout(done, 900));
        if (client)
          await route.fulfill({ contentType: "text/javascript", body: client });
        else await route.continue();
      },
    );
    await page.route(
      "**/plugins/@michengai/dsh-im-connect/client.js*",
      async (route) => {
        if (delayedPlugin === "channels")
          await new Promise((done) => setTimeout(done, 900));
        if (candidate)
          await route.fulfill({
            contentType: "text/javascript",
            body: candidate,
          });
        else await route.continue();
      },
    );
    const tabBar = page.locator(".ima-tabs, .workagent-sidebar-tabs");
    const channelTab = tabBar.locator("button").filter({ hasText: /^频道$/ });
    const taskTab = tabBar.locator("button").filter({ hasText: /^任务$/ });
    const check = async (step) => {
      await channelTab.waitFor();
      assert.equal(await taskTab.count(), 1);
      assert.equal(await channelTab.count(), 1);
      assert.equal(await tabBar.count(), 1);
      if (await page.locator(".workagent-sidebar-tabs").count())
        assert.equal(
          await tabBar.locator("button").filter({ hasText: /^协作/ }).count(),
          1,
        );
      assert.equal(
        await page.locator('[data-slot-error="sidebar.workspaces"]').count(),
        0,
      );
      report.snapshots.push({
        delayed,
        step,
        url: new URL(page.url()).pathname,
        tabs: ["任务", "频道"],
      });
    };
    try {
      await login(page);
      if (expectedClient) {
        const served = await page.request.get(
          `${baseURL}/plugins/@michengai/dsh-im-connect/client.js`,
        );
        assert.equal(served.status(), 200);
        assert.ok(
          (await served.body()).equals(expectedClient),
          "Production plugin differs from the verified candidate",
        );
        report.checks.push(
          "production plugin matches verified candidate byte-for-byte",
        );
      }
      await check("login");
      await channelTab.click();
      assert.ok(
        (await channelTab.getAttribute("aria-selected")) === "true" ||
          (await channelTab.getAttribute("aria-current")) === "page",
      );
      await taskTab.click();
      await page.locator(".workagent-sidebar-browser").waitFor();
      await check("tab-switch");

      // Real read-only document navigation exercises back/forward boot, without
      // relying on another application's availability or creating production data.
      for (let round = 0; round < 2; round++) {
        delayedPlugin = round === 0 ? "channels" : "workagent";
        const response = await page.goto(`${baseURL}/healthz`);
        assert.equal(response.status(), 200);
        await page.goBack({ waitUntil: "domcontentloaded" });
        await check(`back-${round}`);
        await page.goForward({ waitUntil: "domcontentloaded" });
        assert.equal(new URL(page.url()).pathname, "/healthz");
        await page.goBack({ waitUntil: "domcontentloaded" });
        await check(`forward-back-${round}`);
      }
      await page.screenshot({ path: join(evidence, `${delayed}-desktop.png`) });
      report.checks.push(
        `${delayed} loads last: login, tab switching, two back/forward rounds`,
      );
      // Also cover an ordinary in-document transition when the navigation exists.
      const tasks = page.locator('.workagent-footer[data-kind="tasks"]');
      if (await tasks.isVisible()) {
        await tasks.click();
        await page
          .getByRole("dialog", { name: "定时任务", exact: true })
          .waitFor();
        await check("scheduled-page");
        await page.goBack();
        await check("scheduled-back");
      }
    } catch (error) {
      await page.screenshot({ path: join(evidence, `${delayed}-failure.png`) });
      report.diagnostic = await page.evaluate(() => {
        const element = document.querySelector(
          '[data-slot="sidebar.workspaces"]',
        );
        let fiber =
          element?.[
            Object.keys(element).find((key) => key.startsWith("__reactFiber"))
          ];
        let host;
        for (; fiber; fiber = fiber.return) {
          if (fiber.memoizedProps?.value?.entriesOfSlot)
            host = fiber.memoizedProps.value;
        }
        const describe = (entry) => ({
          id: entry.options.id,
          component: entry.component.name,
          wrapped: !!entry.component.__imConnectWrapped,
        });
        return {
          registered: host?.entriesOf("sidebar.workspaces").map(describe),
          active: host?.entriesOfSlot("sidebar.workspaces").map(describe),
          tabCount: document.querySelectorAll(".ima-tabs").length,
          plugins: performance
            .getEntriesByType("resource")
            .filter((entry) => entry.name.includes("dsh-im-connect/client.js"))
            .map((entry) => entry.name),
        };
      });
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.message;
  throw error;
} finally {
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log(JSON.stringify(report));
}
