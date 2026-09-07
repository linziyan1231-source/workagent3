import { withPage, baseURL } from "./smoke-dsh-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

await withPage(async (page) => {
  const titles = [];
  const sessions = await (
    await page.request.get(`${baseURL}/api/runtime/v1/sessions`)
  ).json();
  const paths = ["/?frontend=dsh", "/?frontend=dsh&workagent=workspaces"];
  if (sessions.length)
    paths.push(`/?frontend=dsh&session=${encodeURIComponent(sessions[0].id)}`);
  for (const path of paths) {
    const document = await page.request.get(`${baseURL}${path}`);
    const html = await document.text();
    if (
      !document.ok() ||
      !html.includes("<title>WorkAgent</title>") ||
      html.includes("<title>DeepSeek Harness</title>")
    )
      throw new Error("Initial HTML title is not WorkAgent");
    await page.goto(`${baseURL}${path}`);
    await page.getByText("WorkAgent", { exact: true }).waitFor();
    await page.waitForFunction(() => document.title === "WorkAgent");
    if ((await page.title()) !== "WorkAgent")
      throw new Error(
        `Loaded page title is not WorkAgent: ${JSON.stringify(await page.title())}`,
      );
    await page.reload();
    await page.getByText("WorkAgent", { exact: true }).waitFor();
    await page.waitForFunction(() => document.title === "WorkAgent");
    titles.push(await page.title());
  }
  // Exercise the host renderer's title update after the plugin has mounted.
  await page.evaluate(() => {
    document.title = "Example session — DeepSeek Harness";
  });
  await page.waitForFunction(() => document.title === "WorkAgent");
  const response = await page.request.get(`${baseURL}/manifest.webmanifest`, {
    headers: { "If-None-Match": '"old-manifest"', "Accept-Encoding": "gzip" },
  });
  const manifest = await response.json();
  if (
    response.status() !== 200 ||
    manifest.name !== "WorkAgent" ||
    manifest.short_name !== "WorkAgent" ||
    !manifest.icons.length
  )
    throw new Error("Installed web app name is incorrect");
  if (titles.some((title) => title !== "WorkAgent"))
    throw new Error("Refresh restored the old title");
  const dir = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "web-title.json"),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          titles,
          manifestName: manifest.name,
          manifestShortName: manifest.short_name,
          initialHTML: "WorkAgent",
        },
        null,
        2,
      ),
    );
  }
});
console.log(
  "WorkAgent title smoke passed: initial HTML, hydrated pages, refresh and web app manifest",
);
