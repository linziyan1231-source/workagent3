import {
  baseURL,
  json,
  killSmokeProcess,
  rememberSmokeProcessSID,
  restartSmokeRuntime,
  uniqueName,
  withPage,
} from "./smoke-dsh-helpers.mjs";

const harnessPid = Number(process.env.WORKAGENT_SMOKE_HARNESS_PID);
if (
  !Number.isSafeInteger(harnessPid) ||
  harnessPid <= 0 ||
  harnessPid === process.pid
)
  throw new Error(
    "WORKAGENT_SMOKE_HARNESS_PID must identify the supervised Harness process",
  );

await withPage(async (page) => {
  const workspace = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: uniqueName("automation-workspace") }),
  });
  const presets = await json(page, "/api/runtime/v1/presets");
  const preset =
    presets.find((row) => row.enabled && row.engine === "harness") ||
    presets[0];
  if (!preset) throw new Error("automation smoke requires an enabled preset");
  const name = uniqueName("dsh-automation");
  let automation;
  try {
    await page.goto(`${baseURL}/?workagent=automations`);
    const dialog = page.getByRole("dialog", { name: "automations" });
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByLabel("Preset ID").fill(preset.id);
    await dialog.getByLabel("Workspace ID").fill(workspace.id);
    await dialog.getByLabel("Input").fill(`Reply with ${name}`);
    await dialog.getByRole("button", { name: "Create task" }).click();
    await dialog.getByText(name, { exact: true }).waitFor();
    automation = (await json(page, "/api/runtime/v1/automations")).find(
      (row) => row.name === name,
    );
    if (!automation) throw new Error("automation was not persisted");
    const card = dialog.locator("article", { hasText: name });
    await page.evaluate((expectedName) => {
      window.__workagentAutomationNotice = false;
      const stream = new EventSource("/api/portal/me/notifications/stream");
      stream.addEventListener("notifications", (event) => {
        const value = JSON.parse(event.data);
        if (
          value.notifications?.some((entry) =>
            entry.message?.includes(expectedName),
          )
        ) {
          window.__workagentAutomationNotice = true;
          stream.close();
        }
      });
    }, name);
    await card.getByRole("button", { name: "Run now" }).click();

    await page.waitForFunction(
      async (id) => {
        const response = await fetch(
          `/api/runtime/v1/automations/${encodeURIComponent(id)}/runs`,
        );
        const runs = await response.json();
        return runs.some((run) => ["succeeded", "failed"].includes(run.status));
      },
      automation.id,
      { timeout: 120_000 },
    );
    const runs = await json(
      page,
      `/api/runtime/v1/automations/${encodeURIComponent(automation.id)}/runs`,
    );
    if (!runs.length) throw new Error("automation run was not persisted");
    await page.waitForFunction(() => window.__workagentAutomationNotice, null, {
      timeout: 30_000,
    });
    await page.goto(`${baseURL}/?frontend=dsh`);
    const notificationButton = page.getByRole("button", {
      name: "Notifications",
    });
    await notificationButton.locator(".workagent-badge").waitFor();
    await notificationButton.click();
    const notifications = page.getByRole("dialog", { name: "notifications" });
    const noticeCard = notifications.locator("article", { hasText: name });
    await noticeCard.waitFor();
    const notices = await json(page, "/api/portal/me/notifications");
    const notice = notices.notifications?.find((entry) =>
      entry.message?.includes(name),
    );
    if (!notice) throw new Error("automation did not deliver a notification");
    await noticeCard
      .getByRole("button", {
        name: notice.deep_link ? "Open and acknowledge" : "Acknowledge",
      })
      .click();
    await page.waitForFunction(async (id) => {
      const value = await (await fetch("/api/portal/me/notifications")).json();
      return !value.notifications.some((entry) => entry.id === id);
    }, notice.id);

    await page.goto(`${baseURL}/?workagent=automations`);
    await page.getByText(name, { exact: true }).waitFor();
    const second = await json(
      page,
      `/api/runtime/v1/automations/${encodeURIComponent(automation.id)}/run`,
      { method: "POST" },
    );
    await json(
      page,
      `/api/runtime/v1/automations/${encodeURIComponent(automation.id)}/runs/${encodeURIComponent(second.id)}/cancel`,
      { method: "POST" },
    );
    await rememberSmokeProcessSID(harnessPid);
    await killSmokeProcess(harnessPid);
    await page.waitForFunction(async () => {
      try {
        return !(await fetch("/api/runtime/v1/automations")).ok;
      } catch {
        return true;
      }
    });
    await restartSmokeRuntime(page);
    await page.waitForFunction(
      async (id) => {
        try {
          const response = await fetch("/api/runtime/v1/automations");
          return (
            response.ok && (await response.json()).some((row) => row.id === id)
          );
        } catch {
          return false;
        }
      },
      automation.id,
      { timeout: 120_000, polling: 500 },
    );
  } finally {
    if (automation)
      await json(
        page,
        `/api/runtime/v1/automations/${encodeURIComponent(automation.id)}`,
        {
          method: "DELETE",
        },
      ).catch(() => {});
  }
});

console.log("dsh automation smoke passed");
