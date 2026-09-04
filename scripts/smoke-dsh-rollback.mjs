import { chromium } from "playwright";
import {
  baseURL,
  requireSmokeEnvironment,
  uniqueName,
} from "./smoke-dsh-helpers.mjs";

requireSmokeEnvironment();
const username = process.env.WORKAGENT_SMOKE_LEGACY_USERNAME;
const password = process.env.WORKAGENT_SMOKE_LEGACY_PASSWORD;
if (!username || !password)
  throw new Error(
    "WORKAGENT_SMOKE_LEGACY_USERNAME and WORKAGENT_SMOKE_LEGACY_PASSWORD are required",
  );

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const login = await page.request.post(`${baseURL}/api/auth/login`, {
    data: { username, password },
    headers: { Origin: new URL(baseURL).origin },
  });
  if (!login.ok()) throw new Error(`legacy login returned ${login.status()}`);

  await page.goto(`${baseURL}/?frontend=legacy`);
  await page.getByText("Puxin AI", { exact: true }).waitFor();
  await page.waitForTimeout(2_000);
  for (let index = 0; index < 10; index += 1) {
    const modal = page.locator(".arco-modal-wrapper:visible").last();
    if ((await modal.count()) === 0) break;
    const dismiss = modal
      .getByRole("button", { name: /确定|confirm|ok/i })
      .last();
    if ((await dismiss.count()) === 0)
      throw new Error("visible legacy modal has no dismiss action");
    await dismiss.click({ force: true });
    await page.waitForTimeout(100);
  }
  const marker = uniqueName("legacy-message");
  await page
    .locator('[data-testid="preset-pill-builtin-general"]')
    .getAttribute("data-assistant-selected")
    .then((selected) => {
      if (selected !== "true")
        throw new Error("General preset is not selected");
    });
  const composer = page.getByPlaceholder(/发消息|send a message/i);
  await composer.fill(`Reply exactly with ${marker}`);
  const send = page.locator('[data-testid="guid-send-btn"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="guid-send-btn"]')?.disabled,
  );
  await send.click();
  await page.waitForFunction(
    (value) => document.body.innerText.split(value).length >= 3,
    marker,
    { timeout: 120_000 },
  );

  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.getByText("WorkAgent", { exact: true }).waitFor();
} finally {
  await browser.close();
}

console.log("dsh rollback smoke passed");
