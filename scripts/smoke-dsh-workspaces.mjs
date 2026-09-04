import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const workspace = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: uniqueName("dsh-workspace") }),
  });
  const put = async (path, bytes, contentType) => {
    const response = await page.request.put(
      `${baseURL}/api/runtime/v1/workspaces/${encodeURIComponent(workspace.id)}/content?path=${encodeURIComponent(path)}`,
      {
        data: bytes,
        headers: {
          "Content-Type": contentType,
          Origin: new URL(baseURL).origin,
        },
      },
    );
    if (!response.ok())
      throw new Error(`fixture ${path} returned ${response.status()}`);
  };
  await put("notes.txt", Buffer.from("workspace smoke text"), "text/plain");
  await put(
    "pixel.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
  );
  await put(
    "sample.pdf",
    Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
    ),
    "application/pdf",
  );

  await page.goto(`${baseURL}/?workagent=workspaces`);
  const dialog = page.getByRole("dialog", { name: "workspaces" });
  const card = dialog.locator("article", { hasText: workspace.name });
  await card.getByRole("button", { name: "Browse" }).click();
  for (const fixture of ["notes.txt", "pixel.png", "sample.pdf"])
    await dialog.getByText(fixture, { exact: true }).waitFor();

  await dialog
    .locator("article", { hasText: "notes.txt" })
    .getByRole("button", { name: "Preview" })
    .click();
  await dialog.getByText("workspace smoke text", { exact: true }).waitFor();
  await dialog
    .locator("article", { hasText: "pixel.png" })
    .getByRole("button", { name: "Preview" })
    .click();
  await dialog.locator('img[alt="pixel.png"]').waitFor();
  await dialog
    .locator("article", { hasText: "sample.pdf" })
    .getByRole("button", { name: "Preview" })
    .click();
  const frame = dialog.locator('iframe[title="sample.pdf"]');
  await frame.waitFor();
  const pdf = await page.request.get(
    new URL(await frame.getAttribute("src"), baseURL).href,
  );
  if (!pdf.ok()) throw new Error(`PDF sandbox URL returned ${pdf.status()}`);
});

console.log("dsh workspace smoke passed");
