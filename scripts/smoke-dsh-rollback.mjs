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
  await page.getByRole("heading", { name: "WorkAgent has moved" }).waitFor();
  const fallbackCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "workagent_frontend",
  );
  if (fallbackCookie?.value !== "legacy")
    throw new Error("Portal fallback preference was not persisted");
  await page.reload();
  await page.getByRole("heading", { name: "WorkAgent has moved" }).waitFor();
  await page.getByRole("link", { name: "Continue to WorkAgent" }).click();
  await page.getByText("WorkAgent", { exact: true }).waitFor();
  if (
    (await page.context().cookies()).some(
      (cookie) =>
        cookie.name === "workagent_frontend" && cookie.value === "legacy",
    )
  )
    throw new Error("DSH selection did not clear the fallback preference");
  await page.goto(baseURL);
  await page.getByRole("checkbox", { name: "团队模式" }).waitFor();
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.getByText("WorkAgent", { exact: true }).waitFor();
} finally {
  await browser.close();
}

console.log("dsh rollback smoke passed");
