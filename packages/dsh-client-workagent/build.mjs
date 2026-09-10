import { readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";

const root = new URL("./", import.meta.url);
const main = await readFile(new URL("src/client.js", root), "utf8");
const features = await readFile(new URL("src/workbench.js", root), "utf8");
let output = main.replace("// WORKBENCH_SOURCE", () =>
  features.replace(
    "export function createWorkbench",
    "function createWorkbench",
  ),
);
const navigation = await readFile(new URL("src/navigation.js", root), "utf8");
output = output.replace("// NAVIGATION_SOURCE", () =>
  navigation.replaceAll("export function", "function"),
);
const automations = await readFile(new URL("src/automations.js", root), "utf8");
output = output.replace("// AUTOMATIONS_SOURCE", () =>
  automations.replace(
    "export function createAutomations",
    "function createAutomations",
  ),
);
const imports = await readFile(new URL("src/imports.js", root), "utf8");
output = output.replace("// IMPORTS_SOURCE", () =>
  imports.replace("export function createImports", "function createImports"),
);
const uploads = await readFile(new URL("src/uploads.js", root), "utf8");
output = output.replace("// UPLOADS_SOURCE", () =>
  uploads.replace("export function createUploads", "function createUploads"),
);
const shared = await readFile(new URL("src/shared.js", root), "utf8");
output = output.replace("// SHARED_SOURCE", () =>
  shared.replace("export function createShared", "function createShared"),
);
await writeFile(
  new URL("client.js", root),
  await prettier.format(output, { parser: "babel" }),
);
